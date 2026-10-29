import assert from 'node:assert/strict'
import test from 'node:test'
import { Readable } from 'node:stream'

import { createFeishuAdapter } from '../src/adapters/feishu.js'

const noopLog = { info() {}, warn() {}, error() {} }
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

/** 假 SDK：把"连接"变成可控的回调，把"下载"变成内存流。 */
function fakeSdk({ ready = true, failWith } = {}) {
  const sent = []
  class FakeWSClient {
    constructor(params) {
      this.params = params
      FakeWSClient.last = this
    }

    start({ eventDispatcher }) {
      this.dispatcher = eventDispatcher
      if (failWith !== undefined) {
        // 模拟 endpoint 发现失败：SDK 的行为是异步 reject
        this.params.onError?.(new Error(failWith))
        return Promise.reject(new Error(failWith))
      }
      if (ready) queueMicrotask(() => this.params.onReady?.())
      return new Promise(() => {}) // 真 SDK 的 start() 在连接期间不 settle
    }

    close() {}

    getConnectionStatus() {
      return { state: 'connected', reconnectAttempts: 0 }
    }
  }
  class FakeClient {
    constructor() {
      this.im = {
        v1: {
          messageResource: {
            get: async ({ params }) => ({
              getReadableStream: () => Readable.from([params.type === 'image' ? PNG : Buffer.from('OggS-audio')]),
            }),
          },
        },
        message: {
          create: async (payload) => {
            sent.push(payload)
            return { data: { message_id: `om_${sent.length}` } }
          },
          reply: async (payload) => {
            sent.push(payload)
            return { data: { message_id: `om_r${sent.length}` } }
          },
          patch: async (payload) => {
            sent.push(payload)
            return { data: {} }
          },
        },
      }
    }
  }
  class FakeDispatcher {
    constructor(params) {
      this.params = params
      this.handlers = new Map()
    }

    register(map) {
      for (const [key, handler] of Object.entries(map)) this.handlers.set(key, handler)
      return this
    }

    invoke() {
      return { code: 0 }
    }
  }
  return { WSClient: FakeWSClient, Client: FakeClient, EventDispatcher: FakeDispatcher, LoggerLevel: { warn: 2, info: 3 }, sent }
}

const textEvent = (overrides = {}) => ({
  sender: { sender_type: 'user', sender_id: { open_id: 'ou_1' } },
  message: {
    message_id: 'om_1',
    chat_id: 'oc_1',
    chat_type: 'p2p',
    message_type: 'text',
    content: JSON.stringify({ text: '你好' }),
    ...overrides,
  },
})

test('长连接：start() 能真正走到 ready（回归：startWs 未定义）', async () => {
  const sdk = fakeSdk()
  const inbound = []
  const adapter = createFeishuAdapter({
    config: { appId: 'cli_x', appSecret: 'y', mode: 'ws' },
    log: noopLog,
    sdk,
    onInbound: (msg) => inbound.push(msg),
    onCardAction: async () => ({ toast: 'ok' }),
  })
  await adapter.start() // 曾经在这里抛 ReferenceError: startWs is not defined
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(adapter.status().state, 'connected')
  await adapter.stop()
})

test('长连接：SDK 报错时状态变 error，并且不把异常抛给调用方', async () => {
  const states = []
  const adapter = createFeishuAdapter({
    config: { appId: 'cli_x', appSecret: 'y', mode: 'ws', onState: (next) => states.push(next.state) },
    log: noopLog,
    sdk: fakeSdk({ failWith: 'endpoint discovery failed' }),
    onInbound: () => {},
    onCardAction: async () => ({ toast: 'ok' }),
  })
  await adapter.start()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(adapter.status().state, 'error')
  assert.match(adapter.status().error, /endpoint discovery failed/)
  assert.deepEqual(states, ['error'])
  await adapter.stop()
})

test('入站：文本消息归一化后交给内核，重投被去重', async () => {
  const sdk = fakeSdk()
  const inbound = []
  const adapter = createFeishuAdapter({
    config: { appId: 'cli_x', appSecret: 'y', mode: 'ws' },
    log: noopLog,
    sdk,
    onInbound: (msg) => inbound.push(msg),
    onCardAction: async () => ({ toast: 'ok' }),
  })
  await adapter.start()
  const dispatcher = sdk.WSClient.last.dispatcher
  await dispatcher.handlers.get('im.message.receive_v1')(textEvent())
  await dispatcher.handlers.get('im.message.receive_v1')(textEvent()) // 重投
  assert.equal(inbound.length, 1, '同一个 message_id 只处理一次')
  assert.equal(inbound[0].peerKey, 'feishu:oc_1')
  assert.equal(inbound[0].text, '你好')
  assert.deepEqual(inbound[0].images, [])
  await adapter.stop()
})

test('入站：图片消息会真的下载成 base64 并带上 mime', async () => {
  const sdk = fakeSdk()
  const inbound = []
  const adapter = createFeishuAdapter({
    config: { appId: 'cli_x', appSecret: 'y', mode: 'ws' },
    log: noopLog,
    sdk,
    onInbound: (msg) => inbound.push(msg),
    onCardAction: async () => ({ toast: 'ok' }),
  })
  await adapter.start()
  const dispatcher = sdk.WSClient.last.dispatcher
  await dispatcher.handlers.get('im.message.receive_v1')(textEvent({
    message_id: 'om_img',
    message_type: 'image',
    content: JSON.stringify({ image_key: 'img_1' }),
  }))
  assert.equal(inbound.length, 1)
  assert.equal(inbound[0].text, '')
  assert.equal(inbound[0].images.length, 1)
  assert.equal(inbound[0].images[0].mediaType, 'image/png')
  assert.equal(Buffer.from(inbound[0].images[0].data, 'base64').length, PNG.length)
  await adapter.stop()
})

test('入站：不支持的类型的消息只回一句说明，不建会话', async () => {
  const sdk = fakeSdk()
  const inbound = []
  const adapter = createFeishuAdapter({
    config: { appId: 'cli_x', appSecret: 'y', mode: 'ws' },
    log: noopLog,
    sdk,
    onInbound: (msg) => inbound.push(msg),
    onCardAction: async () => ({ toast: 'ok' }),
  })
  await adapter.start()
  const dispatcher = sdk.WSClient.last.dispatcher
  await dispatcher.handlers.get('im.message.receive_v1')(textEvent({
    message_id: 'om_sticker',
    message_type: 'sticker',
    content: '{}',
  }))
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(inbound.length, 0, '不该进内核')
  assert.equal(sdk.sent.length, 1, '应该直接回一句')
  assert.match(sdk.sent[0].data.content, /暂时处理不了/)
  await adapter.stop()
})

test('卡片按钮：回调带上 peerKey 与 value，并回 toast', async () => {
  const sdk = fakeSdk()
  const actions = []
  const adapter = createFeishuAdapter({
    config: { appId: 'cli_x', appSecret: 'y', mode: 'ws' },
    log: noopLog,
    sdk,
    onInbound: () => {},
    onCardAction: async (action) => {
      actions.push(action)
      return { toast: '已允许' }
    },
  })
  await adapter.start()
  const dispatcher = sdk.WSClient.last.dispatcher
  const result = await dispatcher.handlers.get('card.action.trigger')({
    open_chat_id: 'oc_9',
    operator: { open_id: 'ou_1' },
    action: { value: { hub: 'approve', id: 'Aabc123' } },
  })
  assert.equal(actions.length, 1)
  assert.equal(actions[0].peerKey, 'feishu:oc_9')
  assert.deepEqual(actions[0].value, { hub: 'approve', id: 'Aabc123' })
  assert.equal(result.toast.content, '已允许')
  await adapter.stop()
})

test('webhook 模式：真的监听端口，并原样回 url_verification 的 challenge', async () => {
  const adapter = createFeishuAdapter({
    config: {
      appId: 'cli_x', appSecret: 'y', mode: 'webhook',
      port: 0, host: '127.0.0.1', path: '/feishu/event', verificationToken: 'vt',
    },
    log: noopLog,
    sdk: fakeSdk(),
    onInbound: () => {},
    onCardAction: async () => ({ toast: 'ok' }),
  })
  await adapter.start()
  const address = adapter.address()
  assert.ok(address !== undefined, '应该已经监听')
  const base = `http://127.0.0.1:${address.port}`

  const challenge = await fetch(`${base}/feishu/event`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'url_verification', challenge: 'abc123' }),
  })
  assert.equal(challenge.status, 200)
  assert.deepEqual(await challenge.json(), { challenge: 'abc123' })

  const wrongPath = await fetch(`${base}/other`, { method: 'POST', body: '{}' })
  assert.equal(wrongPath.status, 404)
  await adapter.stop()
})
