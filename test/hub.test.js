import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFakeHost } from './fake-host.js'
import { createHub } from '../src/index.js'
import { loadConfig } from '../src/config.js'
import { createMockAdapter } from '../src/adapters/mock.js'

const noopLog = { info() {}, warn() {}, error() {}, child() { return this } }

/**
 * 端到端：假宿主 + 内存适配器 + 真内核。
 *
 * 这条链路上每个环节都是生产代码（路由、队列、桥、出站、格式化），
 * 只有"平台"和"模型"是假的。
 */
async function boot({ allowAll = true, allowPeers = [], reply = (text) => `echo: ${text}`, hubOptions = {} } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'hub-e2e-'))
  const host = createFakeHost({ reply })
  const config = loadConfig({
    stateDir,
    patchConfig: {
      adapters: { mock: { enabled: true } },
      security: { allowAll, allowPeers },
      agent: { cwd: stateDir },
      behavior: { progressAfterMs: 0, journal: false, ...hubOptions },
    },
    env: {},
  })
  /** @type {any} */
  let hub
  const adapter = createMockAdapter({
    log: noopLog,
    onInbound: (msg) => hub.handleInbound(msg),
    onCardAction: (action) => hub.handleCardAction(action),
  })
  hub = createHub({ ctx: host.ctx, config, stateDir, log: noopLog, adapters: new Map([['mock', adapter]]) })
  await hub.start()
  return { hub, host, adapter, stateDir, config }
}

const texts = (adapter) => adapter.outbound.filter((item) => item.kind === 'text').map((item) => item.text)
const cards = (adapter) => adapter.outbound.filter((item) => item.kind === 'card')
const updates = (adapter) => adapter.outbound.filter((item) => item.kind === 'update')

test('E2E：一句话 → 进度卡 → 更新成最终答案', async () => {
  const { hub, adapter } = await boot()
  await adapter.inject({ text: '你好' })

  assert.equal(cards(adapter).length, 1, '应该先发一张进度卡')
  const update = updates(adapter).at(-1)
  assert.ok(update !== undefined, '进度卡应该被更新成答案')
  assert.match(JSON.stringify(update.card), /echo: 你好/)
  assert.equal(hub.router.get('mock:chat1').turns, 1)
  await hub.stop()
})

test('E2E：命令不消耗模型回合', async () => {
  const { hub, host, adapter } = await boot()
  await adapter.inject({ text: '/help' })
  assert.equal(host.created.length, 0, '/help 不该创建会话')
  assert.ok(texts(adapter)[0].includes('/status'))

  await adapter.inject({ text: '/status' })
  assert.ok(texts(adapter).some((text) => text.includes('出站队列')))
  await hub.stop()
})

test('E2E：白名单为空 ⇒ 不建会话，只回一条引导', async () => {
  const { hub, host, adapter } = await boot({ allowAll: false, allowPeers: [] })
  await adapter.inject({ text: '你好' })
  assert.equal(host.created.length, 0)
  const sent = texts(adapter)
  assert.equal(sent.length, 1)
  assert.match(sent[0], /还没有被授权/)
  assert.match(sent[0], /mock:chat1/)
  await hub.stop()
})

test('E2E：白名单命中才放行', async () => {
  const { hub, adapter } = await boot({ allowAll: false, allowPeers: ['mock:chat1'] })
  await adapter.inject({ text: '你好' })
  assert.ok(updates(adapter).length > 0)
  await hub.stop()
})

test('E2E：重复投递的消息只处理一次', async () => {
  const { hub, adapter } = await boot()
  await adapter.inject({ text: '数一下', messageId: 'same-id' })
  await adapter.inject({ text: '数一下', messageId: 'same-id' })
  assert.equal(cards(adapter).length, 1)
  await hub.stop()
})

test('E2E：/new 换会话，旧会话不再被路由', async () => {
  const { hub, adapter } = await boot()
  await adapter.inject({ text: '第一轮' })
  const before = hub.router.get('mock:chat1').sessionId
  assert.equal(hub.router.get('mock:chat1').turns, 1)
  await adapter.inject({ text: '/new' })
  const after = hub.router.get('mock:chat1').sessionId
  assert.notEqual(before, after)
  assert.equal(hub.router.peerForSession(before), undefined)
  // 新代次的轮次从 0 重新计数，旧代次留在 DSH 里。
  assert.equal(hub.router.get('mock:chat1').turns, 0)
  await adapter.inject({ text: '第二轮' })
  assert.equal(hub.router.get('mock:chat1').turns, 1)
  assert.equal(hub.router.get('mock:chat1').sessionId, after)
  await hub.stop()
})

test('E2E：审批卡按钮点一下就生效（聊天里点按钮）', async () => {
  const { hub, host, adapter } = await boot()
  await adapter.inject({ text: '先建一个会话' })
  const sessionId = hub.router.get('mock:chat1').sessionId
  const agent = host.agents.get(sessionId)

  let outcome
  const pending = host.requestApproval({ agent, toolName: 'pwsh' }).then((value) => { outcome = value })
  await new Promise((resolve) => setTimeout(resolve, 10))
  const approvalCard = cards(adapter).find((item) => item.card?.header?.title?.content?.includes('权限'))
  assert.ok(approvalCard !== undefined, '应该发审批卡')

  const button = approvalCard.card.elements.find((element) => element.tag === 'action').actions[0]
  const result = await adapter.click({ value: button.value })
  assert.match(result.toast, /允许/)
  await pending
  assert.equal(outcome, 'allowed-once')
  await hub.stop()
})

test('E2E：agent 失败时把原因发回聊天，而不是静默', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'hub-e2e-fail-'))
  const failing = createFakeHost({ failWith: 'provider timeout' })
  const config = loadConfig({
    stateDir,
    patchConfig: {
      adapters: { mock: { enabled: true } },
      security: { allowAll: true },
      agent: { cwd: stateDir },
      behavior: { progressAfterMs: 0, journal: false },
    },
    env: {},
  })
  let hub2
  const adapter2 = createMockAdapter({
    log: noopLog,
    onInbound: (msg) => hub2.handleInbound(msg),
    onCardAction: (action) => hub2.handleCardAction(action),
  })
  hub2 = createHub({ ctx: failing.ctx, config, stateDir, log: noopLog, adapters: new Map([['mock', adapter2]]) })
  await hub2.start()
  await adapter2.inject({ text: '跑个任务' })

  const failedCard = updates(adapter2).at(-1)?.card ?? cards(adapter2).at(-1)?.card
  assert.match(JSON.stringify(failedCard), /provider timeout/)
  await hub2.stop()
})

const PNG_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]).toString('base64')

test('E2E：超长回答分段时，后续段落也不能露出 markdown 星号', async () => {
  const long = Array.from({ length: 40 }, (_, i) => `**第 ${i + 1} 条**：这是一段用来触发分段的说明文字。`).join('\n')
  const { hub, adapter } = await boot({
    reply: () => long,
    hubOptions: { chunkLimit: 300 },
  })
  await adapter.inject({ text: '来点长的' })
  const sentTexts = adapter.outbound.filter((item) => item.kind === 'text').map((item) => item.text)
  // 段落要么进卡片（markdown 会被飞书渲染），要么作为纯文本但**不带装饰**。
  for (const text of sentTexts) {
    assert.equal(text.includes('**'), false, `纯文本里不该出现 markdown 星号：${text.slice(0, 60)}`)
  }
  const continuation = cards(adapter).filter((item) => String(item.card?.header?.title?.content ?? '').includes('续'))
  assert.ok(continuation.length > 0, '长回答应该产生「续」卡片')
  assert.match(JSON.stringify(continuation[0].card), /第 /)
  await hub.stop()
})

test('E2E：图片消息把 image 块（durable ref）交给 agent', async () => {
  const { hub, host, adapter } = await boot()
  await adapter.inject({
    text: '看看这张图',
    images: [{ mediaType: 'image/png', data: PNG_BASE64 }],
  })
  const message = host.messages.at(-1)
  assert.ok(message !== undefined, 'agent 应该收到一条消息')
  const image = message.content.find((part) => part.type === 'image')
  assert.ok(image !== undefined, '消息里应该有 image 块')
  assert.equal(image.attachment.id, 'att-1', 'image 必须是宿主准入后的 ref，而不是裸 base64')
  await hub.stop()
})

test('E2E：只有图片没有文字也能触发一轮，标题自动取“［图片］”', async () => {
  const { hub, adapter } = await boot()
  await adapter.inject({ images: [{ mediaType: 'image/png', data: PNG_BASE64 }] })
  assert.equal(hub.router.get('mock:chat1').title, '［图片］')
  assert.equal(hub.router.get('mock:chat1').turns, 1)
  await hub.stop()
})

test('E2E：语音在没有转写服务时降级成附件 + 说明，仍然跑一轮', async () => {
  const { hub, host, adapter } = await boot()
  await adapter.inject({ audio: { data: Buffer.from('OggS...'), format: 'ogg', durationMs: 3000 } })
  const message = host.messages.at(-1)
  assert.equal(message.content.some((part) => part.type === 'file'), true, '音频应作为文件附件')
  assert.equal(message.content.some((part) => part.type === 'text' && /语音/.test(part.text)), true, '应有文字说明')
  await hub.stop()
})

test('E2E：图片超过本地上限时只提示、不把整条消息丢掉', async () => {
  const { hub, adapter } = await boot({ hubOptions: { media: { imageMaxBytes: 10 } } })
  await adapter.inject({ text: '看这个', images: [{ mediaType: 'image/png', data: PNG_BASE64 }] })
  assert.ok(texts(adapter).some((text) => text.includes('超过')), JSON.stringify(texts(adapter)))
  assert.equal(hub.router.get('mock:chat1').turns, 1, '文字部分仍应正常执行')
  await hub.stop()
})
