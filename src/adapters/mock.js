/**
 * 内存适配器：给单测和 `npm run demo` 用。
 *
 * 它证明一件重要的事：内核（路由 / 队列 / 审批 / 出站重试）跟平台无关。
 * 换平台只实现 sendText / sendCard / updateCard 这三个方法就够了。
 */
import { SeenSet } from '../store.js'

export function createMockAdapter({ onInbound, onCardAction, log } = {}) {
  const seen = new SeenSet(256)
  /** 所有发出去的东西，测试直接断言这个数组。 */
  const outbound = []
  let counter = 0

  const adapter = {
    id: 'mock',
    capabilities: { text: true, card: true, updateCard: true, actions: true },
    outbound,
    chatIdOf: (peerKey) => String(peerKey).replace(/^mock:/, ''),

    async start() {},
    async stop() {},

    async sendText({ peerKey, text, replyTo }) {
      const record = { kind: 'text', peerKey, text, replyTo, id: `m${++counter}` }
      outbound.push(record)
      log?.info(`[mock→${peerKey}] ${text}`)
      return record.id
    },

    async sendCard({ peerKey, card, replyTo }) {
      const record = { kind: 'card', peerKey, card, replyTo, id: `m${++counter}` }
      outbound.push(record)
      log?.info(`[mock→${peerKey}] card ${card?.header?.title?.content ?? ''}`)
      return record.id
    },

    async updateCard({ messageId, card }) {
      const record = { kind: 'update', messageId, card, id: `m${++counter}` }
      outbound.push(record)
      log?.info(`[mock↻${messageId}] card updated`)
    },

    /** 测试用：模拟一条入站消息。 */
    async inject({ peerKey = 'mock:chat1', text = '', messageId = `in${++counter}`, chatType = 'p2p', replyTo, images, audio, files } = {}) {
      if (!seen.add(messageId)) return false
      await onInbound({
        platform: 'mock',
        peerKey,
        chatId: peerKey.replace(/^mock:/, ''),
        chatType,
        messageId,
        text,
        images,
        audio,
        files,
        senderId: 'u1',
        replyTo: replyTo ?? messageId,
      })
      return true
    },

    /** 测试用：模拟一次卡片按钮点击。 */
    async click({ peerKey = 'mock:chat1', value }) {
      return await onCardAction({ platform: 'mock', peerKey, chatId: peerKey.replace(/^mock:/, ''), value })
    },
  }
  return adapter
}
