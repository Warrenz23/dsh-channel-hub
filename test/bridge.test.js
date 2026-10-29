import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFakeHost } from './fake-host.js'
import { SessionRouter, sessionIdFor } from '../src/router.js'
import { AgentBridge, messageText, streamText } from '../src/bridge.js'

const noopLog = { info() {}, warn() {}, error() {}, child() { return this } }
const tmp = () => mkdtempSync(join(tmpdir(), 'hub-bridge-'))

function setup(options = {}) {
  const host = createFakeHost(options)
  const router = new SessionRouter({ file: join(tmp(), 'sessions.json') })
  const bridge = new AgentBridge({
    ctx: host.ctx,
    router,
    cwd: process.cwd(),
    log: noopLog,
    progressAfterMs: 0,
    ...options.bridge,
  })
  bridge.start()
  return { host, router, bridge }
}

test('streamText 兼容两种 stream 形态', () => {
  assert.equal(streamText([{ type: 'text-chunks', texts: ['a', 'b'] }]), 'ab')
  assert.equal(streamText([{ type: 'chunk', chunk: { type: 'text-delta', text: 'x' } }]), 'x')
  assert.equal(streamText(undefined), '')
})

test('messageText 只取 text 块', () => {
  assert.equal(messageText({ content: [{ type: 'text', text: 'hi' }, { type: 'image' }] }), 'hi')
})

test('deliver：建会话、投递、收到回复文本', async () => {
  const { host, bridge } = setup({ reply: '答案是 42' })
  const result = await bridge.deliver({ peerKey: 'mock:chat1', text: '问题' })
  assert.equal(result.text, '答案是 42')
  assert.equal(result.sessionId, sessionIdFor('mock:chat1'))
  // 传给 create 的 meta.cwd 必须存在，否则 GUI 里会归到 Ungrouped
  assert.equal(typeof host.created[0].meta?.cwd, 'string')
})

test('deliver：同一 peer 的第二轮 resume 同一个会话', async () => {
  const { host, router, bridge } = setup({ reply: (text) => `你说的是 ${text}` })
  const first = await bridge.deliver({ peerKey: 'mock:chat1', text: 'A' })
  const second = await bridge.deliver({ peerKey: 'mock:chat1', text: 'B' })
  assert.equal(first.sessionId, second.sessionId)
  assert.equal(second.text, '你说的是 B')
  assert.equal(router.get('mock:chat1').turns, 0, 'turn 计数由 hub 负责，bridge 不重复记')
  assert.equal(host.created.length, 1)
})

test('deliver：turn 以 error 结束 ⇒ 带回可读原因，而不是干等超时', async () => {
  const { bridge } = setup({ failWith: 'model overloaded' })
  const result = await bridge.deliver({ peerKey: 'mock:chat1', text: '问题' })
  assert.equal(result.error, 'model overloaded')
  assert.equal(result.text, '')
})

test('deliver：不会被上一轮的 assistant/message 冒领', async () => {
  const { host, router, bridge } = setup({ reply: '新答案' })
  // 先造一个"上一轮"的历史：里面已经有一条 assistant/message
  const entry = router.ensure('mock:chat1')
  const handle = await host.agents.create({ sessionId: entry.sessionId })
  const stale = handle.agent.session.append('assistant/message', { stream: [{ type: 'text-chunks', texts: ['旧答案'] }] })
  host.emit('session/event', handle.agent.session, stale)

  const result = await bridge.deliver({ peerKey: 'mock:chat1', text: '再来一次' })
  assert.equal(result.text, '新答案')
})

test('deliver：别人（GUI）那一轮的 turn/end 不会提前结束我们的等待', async () => {
  const { host, router, bridge } = setup({ latencyMs: 30, reply: '我们的答案' })
  const entry = router.ensure('mock:chat1')
  const handle = await host.agents.create({ sessionId: entry.sessionId })

  const inflight = bridge.deliver({ peerKey: 'mock:chat1', text: '问题' })
  // 在 baseline 之后立刻插一个陌生 turn 的收尾
  await new Promise((resolve) => setTimeout(resolve, 5))
  const foreignEnd = handle.agent.session.append('turn/end', { reason: { kind: 'completed' } })
  host.emit('session/event', handle.agent.session, foreignEnd)

  const result = await inflight
  assert.equal(result.text, '我们的答案')
})

test('cancel：把取消请求转成一句话', async () => {
  const { host, bridge } = setup({ reply: 'x', latencyMs: 1000 })
  const inflight = bridge.deliver({ peerKey: 'mock:chat1', text: '慢任务' })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.match(bridge.cancel('mock:chat1'), /已请求中断/)
  assert.match(bridge.cancel('mock:nobody'), /没有正在执行/)
  void inflight
  void host
})

test('describe 输出会话状态', async () => {
  const { bridge } = setup()
  assert.match(bridge.describe('mock:nobody'), /还没有会话/)
  await bridge.deliver({ peerKey: 'mock:chat1', text: '第一句' })
  const text = bridge.describe('mock:chat1')
  assert.match(text, /hub-[0-9a-f]{12}-g0/)
})
