import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFakeHost } from './fake-host.js'
import { apply } from '../src/index.js'
import { extractText, shouldHandleChat } from '../src/adapters/feishu.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'hub-apply-'))
const settle = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms))

test('飞书：文本消息取正文并去掉 @ 占位符', () => {
  const text = extractText({
    message_type: 'text',
    content: JSON.stringify({ text: '@_user_1 帮我看看这个' }),
    mentions: [{ key: '@_user_1', name: 'bot' }],
  })
  assert.equal(text, '帮我看看这个')
})

test('飞书：富文本 post 逐段拼接', () => {
  const text = extractText({
    message_type: 'post',
    content: JSON.stringify({
      content: [
        [{ tag: 'text', text: '第一行' }],
        [{ tag: 'a', text: '链接', href: 'https://example.com' }],
      ],
    }),
  })
  assert.match(text, /第一行/)
  assert.match(text, /链接 https:\/\/example\.com/)
})

test('飞书：非文本消息返回空串（调用方据此回"暂不支持"）', () => {
  assert.equal(extractText({ message_type: 'image', content: '{}' }), '')
  assert.equal(extractText({ message_type: 'text', content: 'not json' }), '')
})

test('飞书：群聊默认只在被点到时响应', () => {
  const config = { allowedChatTypes: ['p2p', 'group'], groupMentionOnly: true }
  assert.equal(shouldHandleChat({ chatType: 'p2p', config, text: '随便说' }), true)
  assert.equal(shouldHandleChat({ chatType: 'group', config, text: '大家早上好' }), false)
  assert.equal(shouldHandleChat({ chatType: 'group', config, text: '助手 帮我跑个测试' }), true)
  assert.equal(shouldHandleChat({ chatType: 'group', config: { allowedChatTypes: ['p2p'] }, text: '助手' }), false)
})

test('apply()：配置齐全时能启动并接收消息（走真实插件入口）', async () => {
  const stateDir = tmp()
  const host = createFakeHost({ reply: '来自 agent 的回答' })
  const hub = apply(host.ctx, {
    stateDir,
    admin: { enabled: false },
    adapters: { mock: { enabled: true } },
    security: { allowAll: true },
    agent: { cwd: stateDir },
    behavior: { progressAfterMs: 0, journal: false },
  })
  await settle()
  await hub.handleInbound({
    platform: 'mock',
    peerKey: 'mock:chat1',
    chatId: 'chat1',
    chatType: 'p2p',
    messageId: 'm1',
    text: '你好',
    senderId: 'u1',
  })
  assert.equal(hub.router.get('mock:chat1').turns, 1)
  assert.equal(hub.router.get('mock:chat1').sessionId.startsWith('hub-'), true)
  await hub.dispose()
})

test('apply()：配置不全时不启动，但不抛错、不拖垮宿主', async () => {
  const stateDir = tmp()
  const host = createFakeHost()
  const hub = apply(host.ctx, {
    stateDir,
    admin: { enabled: false },
    adapters: { feishu: { enabled: true, appId: 'cli_xxx', appSecret: '' } },
    security: { allowPeers: [] },
    behavior: { progressAfterMs: 0, journal: false },
  })
  await settle(20)
  // 没有启动任何适配器，但仍然返回了可查询的 hub（doctor/日志能看到原因）
  assert.deepEqual(hub.stats().adapters, ['feishu'])
  await hub.dispose()
})

test('apply()：配置不全也会先挂上事件订阅（控制台现场补配置后立刻能跑）', async () => {
  const stateDir = tmp()
  const host = createFakeHost({ reply: '配好了就能回' })
  // 典型首装现场：飞书凭证还没填（problems > 0），但白名单已经写进去了。
  const hub = apply(host.ctx, {
    stateDir,
    admin: { enabled: false },
    adapters: { mock: { enabled: true }, feishu: { enabled: true, appId: '', appSecret: '' } },
    security: { allowAll: true },
    agent: { cwd: stateDir },
    behavior: { progressAfterMs: 0, journal: false },
  })
  await settle(20)
  await hub.handleInbound({
    platform: 'mock',
    peerKey: 'mock:chat1',
    chatId: 'chat1',
    chatType: 'p2p',
    messageId: 'm1',
    text: '你好',
    senderId: 'u1',
  })
  // 曾经的 bug：problems > 0 时连 bridge 都没订阅，回合永远等不到 turn/end。
  assert.equal(hub.router.get('mock:chat1').turns, 1)
  await hub.dispose()
})
