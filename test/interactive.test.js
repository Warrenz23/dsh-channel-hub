import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFakeHost } from './fake-host.js'
import { SessionRouter } from '../src/router.js'
import { CardGate, parseChoices, parseDecision } from '../src/cards.js'

const noopLog = { info() {}, warn() {}, error() {}, child() { return this } }
const tmp = () => mkdtempSync(join(tmpdir(), 'hub-cards-'))

async function setup({ dismissGuiCard = false, timeoutMs = 60_000 } = {}) {
  const host = createFakeHost()
  const router = new SessionRouter({ file: join(tmp(), 'sessions.json') })
  const entry = router.ensure('mock:chat1')
  const handle = await host.agents.create({ sessionId: entry.sessionId })
  const cards = []
  const texts = []
  const gate = new CardGate({
    ctx: host.ctx,
    router,
    log: noopLog,
    notifier: {
      sendApprovalCard: async (peerKey, info) => { cards.push({ peerKey, ...info }) },
      sendQuestionCard: async (peerKey, info) => { cards.push({ peerKey, ...info, question: true }) },
      sendText: async (peerKey, text) => { texts.push({ peerKey, text }) },
    },
    timeoutMs,
    dismissGuiCard,
  })
  gate.install()
  return { host, router, gate, cards, texts, agent: handle.agent, sessionId: entry.sessionId }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

test('parseDecision 认中英文与斜杠形式', () => {
  assert.equal(parseDecision('1'), 'allowed-once')
  assert.equal(parseDecision('允许'), 'allowed-once')
  assert.equal(parseDecision('/approve'), 'allowed-once')
  assert.equal(parseDecision('2'), 'rejected')
  assert.equal(parseDecision('/deny'), 'rejected')
  assert.equal(parseDecision('也许'), undefined)
})

test('parseChoices 只接受合法编号', () => {
  assert.deepEqual(parseChoices('1,3', 3), [0, 2])
  assert.deepEqual(parseChoices('2 2', 3), [1])
  assert.equal(parseChoices('4', 3), undefined)
  assert.equal(parseChoices('a', 3), undefined)
})

test('审批：卡片发到聊天，用户回 1 即 allowed-once', async () => {
  const { host, gate, cards, agent } = await setup()
  const pending = host.requestApproval({ agent, toolName: 'pwsh' })
  await tick()
  assert.equal(cards.length, 1, '应该发一张审批卡')
  assert.equal(cards[0].toolName, 'pwsh')
  assert.match(cards[0].id, /^A[0-9a-f]{6}$/)

  const reply = await gate.answerFromText('mock:chat1', '1')
  assert.equal(reply.handled, true)
  assert.match(reply.reply, /允许/)
  assert.equal(await pending, 'allowed-once')
  assert.equal(gate.pendingFor('mock:chat1').length, 0)
})

test('审批：回 2 拒绝', async () => {
  const { host, gate, agent } = await setup()
  const pending = host.requestApproval({ agent, toolName: 'pwsh' })
  await tick()
  await gate.answerFromText('mock:chat1', '2')
  assert.equal(await pending, 'rejected')
})

test('审批：按钮回调同样生效', async () => {
  const { host, gate, cards, agent } = await setup()
  const pending = host.requestApproval({ agent, toolName: 'pwsh' })
  await tick()
  const result = await gate.answerFromAction({
    peerKey: 'mock:chat1',
    value: { hub: 'approve', id: cards[0].id },
  })
  assert.match(result.toast, /允许/)
  assert.equal(await pending, 'allowed-once')
})

test('审批：GUI 先答时，聊天侧收到已处理的回执', async () => {
  const { host, gate, texts, agent } = await setup()
  // 模拟网页端：排在后面的 answerer，由测试手动结算。
  let answerGui
  const off = host.ctx.on('approval/request', () => new Promise((resolve) => { answerGui = resolve }))
  const pending = host.requestApproval({ agent, toolName: 'pwsh' })
  await tick()
  answerGui('rejected')
  assert.equal(await pending, 'rejected')
  await tick()
  off()
  assert.ok(texts.some((item) => item.text.includes('已在其他端处理')), JSON.stringify(texts))
  assert.equal(gate.pendingFor('mock:chat1').length, 0)
})

test('审批：turn 的 signal 中止 ⇒ cancelled', async () => {
  const { host, agent } = await setup()
  const controller = new AbortController()
  const pending = host.requestApproval({ agent, signal: controller.signal })
  await tick()
  controller.abort()
  assert.equal(await pending, 'cancelled')
})

test('审批：不属于本通道的会话直接 next()，不抢 GUI 的卡', async () => {
  const { host } = await setup()
  const foreign = await host.agents.create({ sessionId: 'someone-else' })
  let called = false
  host.ctx.on('approval/request', async () => { called = true; return 'rejected' })
  const outcome = await host.requestApproval({ agent: foreign.agent })
  assert.equal(outcome, 'rejected')
  assert.equal(called, true)
})

test('审批：超时只摘卡，不替用户决定', async () => {
  const { host, gate, texts, agent } = await setup({ timeoutMs: 30 })
  // 网页端（下游 answerer）在请求发起前就存在，由测试手动结算。
  let answerGui
  host.ctx.on('approval/request', () => new Promise((resolve) => { answerGui = resolve }))
  const pending = host.requestApproval({ agent, toolName: 'pwsh' })
  await new Promise((resolve) => setTimeout(resolve, 90))
  assert.equal(gate.pendingFor('mock:chat1').length, 0, '超时后卡片应从聊天侧撤下')
  assert.ok(texts.some((item) => item.text.includes('超时')), JSON.stringify(texts))

  // 卡片虽然撤了，但这张审批没有被我们裁决 —— 网页端仍然可以答。
  answerGui('allowed-once')
  assert.equal(await pending, 'allowed-once')
})

test('提问：编号回复变成 answers 结构', async () => {
  const { host, gate, cards, agent } = await setup()
  const pending = host.requestQuestion({
    agent,
    questions: [{
      id: 'q1',
      question: '走哪条？',
      header: '选择',
      options: [{ label: '快' }, { label: '稳' }],
    }],
  })
  await tick()
  assert.equal(cards.length, 1, '应该发一张提问卡')
  const reply = await gate.answerFromText('mock:chat1', '2')
  assert.match(reply.reply, /稳/)
  const answer = await pending
  assert.deepEqual(answer, { answers: [{ id: 'q1', selected: ['稳'] }] })
})

test('多张待办卡片时要求点名', async () => {
  const { host, gate, agent } = await setup()
  const first = host.requestApproval({ agent, toolName: 'a' })
  const second = host.requestApproval({ agent, toolName: 'b' })
  await tick()
  const reply = await gate.answerFromText('mock:chat1', '1')
  assert.equal(reply.handled, true)
  assert.match(reply.reply, /点名/)
  assert.equal(gate.pendingFor('mock:chat1').length, 2)

  const ids = gate.pendingFor('mock:chat1').map((item) => item.id)
  await gate.answerFromText('mock:chat1', `/deny ${ids[0]}`)
  await gate.answerFromText('mock:chat1', `/approve ${ids[1]}`)
  assert.equal(await first, 'rejected')
  assert.equal(await second, 'allowed-once')
})
