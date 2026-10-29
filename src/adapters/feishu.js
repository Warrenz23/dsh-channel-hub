/**
 * 飞书（Lark）适配器。
 *
 * 为什么选飞书做第一条通道：它是**唯一不需要公网 IP** 的官方 IM 接入方式。
 * 飞书开放平台提供 WebSocket「长连接」模式 —— 客户端主动连出去，事件从这条
 * 连接推回来。桌面版 DSH 跑在个人电脑上、没有公网地址、也不想开内网穿透，
 * 长连接把这个问题直接消掉了。
 *
 * 适配器只做四件事：收事件、发消息、发卡片、改卡片。会话、队列、审批、重试
 * 全在内核里，换一个平台不需要动这些。
 */
import { SeenSet } from '../store.js'
import { sniffImageMime } from '../media.js'

/** post（富文本）里的文字与图片分别抽出来。 */
export function postParts(parsed) {
  let text = ''
  const imageKeys = []
  for (const line of parsed?.content ?? []) {
    if (!Array.isArray(line)) continue
    for (const item of line) {
      if (item?.tag === 'text' && typeof item.text === 'string') text += item.text
      else if (item?.tag === 'a' && typeof item.text === 'string') text += `${item.text} ${item.href ?? ''}`
      else if (item?.tag === 'img' && typeof item.image_key === 'string') imageKeys.push(item.image_key)
    }
    text += '\n'
  }
  return { text: text.trim(), imageKeys }
}

/**
 * 飞书卡片的 markdown 方言转换。
 *
 * 飞书 `markdown` 元素**不支持标题（#）和表格**：标题会原样显示 `## 目录`，
 * 表格会变成一堆竖线。这不是"没渲染好"，是它的方言就这样。
 *
 * 转换规则（保留信息，不猜内容）：
 *  - `## 标题`     → `**标题**`
 *  - markdown 表格 → `· **第一列** — 第二列 — 第三列`（去掉对齐行）
 *  - 代码块原样保留（它支持）
 *
 * 放在适配器层而不是 format.js：这是平台差异。企业微信/其他平台支持标题，
 * 就不该做同样的转换。
 */
export function normalizeCardMarkdown(text) {
  const lines = String(text ?? '').split('\n')
  const out = []
  let inFence = false
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      out.push(line)
      continue
    }
    // 代码块里的 `## 注释` 是代码，不是标题。
    out.push(inFence ? line : line.replace(/^#{1,6}\s+(.+)$/, '**$1**'))
  }
  return convertTables(out.join('\n'))
}

/** 把连续的表格行折成列表项（跳过代码块）。 */
export function convertTables(text) {
  const isRow = (line) => /^\s*\|.*\|\s*$/.test(line)
  const lines = String(text ?? '').split('\n')
  const out = []
  let inFence = false
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*```/.test(lines[i])) {
      inFence = !inFence
      out.push(lines[i])
      continue
    }
    if (inFence || !isRow(lines[i])) {
      out.push(lines[i])
      continue
    }
    const block = []
    while (i < lines.length && isRow(lines[i])) {
      block.push(lines[i])
      i += 1
    }
    i -= 1
    const rows = block.map((line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim()))
    const header = rows[0] ?? []
    const body = rows.slice(1).filter((row) => !row.every((cell) => /^:?-{2,}:?$/.test(cell)))
    if (body.length === 0) {
      if (header.some(Boolean)) out.push(`**${header.filter(Boolean).join(' · ')}**`)
      continue
    }
    for (const row of body) {
      const parts = row
        .map((cell, index) => (index === 0 && cell !== '' ? `**${cell}**` : cell))
        .filter((cell) => cell !== '')
      if (parts.length > 0) out.push(`· ${parts.join(' — ')}`)
    }
  }
  return out.join('\n')
}

/** 深拷贝并转换所有 markdown 元素（卡片对象属于调用方，不能改原件）。 */
export function normalizeCard(card) {
  if (card === null || typeof card !== 'object') return card
  let clone
  try {
    clone = structuredClone(card)
  } catch {
    clone = JSON.parse(JSON.stringify(card))
  }
  for (const element of clone.elements ?? []) {
    if (element?.tag === 'markdown' && typeof element.content === 'string') {
      element.content = normalizeCardMarkdown(element.content)
    }
  }
  return clone
}

/**
 * 把飞书消息归一化成一个描述对象（纯函数，可单测）。
 *
 * @returns {{kind:'text'|'post'|'image'|'audio'|'file'|'unsupported', text?: string,
 *   imageKey?: string, imageKeys?: string[], fileKey?: string, fileName?: string,
 *   durationMs?: number, format?: string}}
 */
export function parseMessage(message) {
  const type = message?.message_type
  let content
  try {
    content = JSON.parse(message?.content ?? '{}')
  } catch {
    return { kind: 'unsupported' }
  }
  switch (type) {
    case 'text':
      return { kind: 'text', text: typeof content.text === 'string' ? content.text : '' }
    case 'post': {
      const { text, imageKeys } = postParts(content)
      return { kind: 'post', text, imageKeys }
    }
    case 'image':
      return { kind: 'image', imageKey: content.image_key }
    case 'audio':
      return {
        kind: 'audio',
        fileKey: content.file_key,
        durationMs: typeof content.duration === 'number' ? content.duration : undefined,
        format: 'ogg',
      }
    case 'file':
      return { kind: 'file', fileKey: content.file_key, fileName: content.file_name }
    case 'media':
      // 视频：当作普通文件转交（能不能处理交给 agent 决定）
      return { kind: 'file', fileKey: content.file_key, fileName: content.file_name ?? 'video.mp4' }
    default:
      return { kind: 'unsupported' }
  }
}

/** 从飞书文本消息的 content JSON 里取正文并去掉 @ 占位符。 */
export function extractText(message) {
  const parsed = parseMessage(message)
  if (parsed.kind !== 'text' && parsed.kind !== 'post') return ''
  let text = parsed.text ?? ''
  for (const mention of message?.mentions ?? []) {
    if (typeof mention.key === 'string') text = text.split(mention.key).join('')
  }
  return text.trim()
}

/** 群聊里没有 @ 机器人、也没点名时，按配置决定要不要理。 */
export function shouldHandleChat({ chatType, config, text, mentioned }) {
  const allow = config.allowedChatTypes ?? ['p2p', 'group']
  if (!allow.includes(chatType)) return false
  if (chatType !== 'group') return true
  if (config.groupMentionOnly !== true) return true
  // 图片/语音消息本身没有文字，但 @ 会落在 mentions 里 —— 那是唯一可靠的信号。
  if (mentioned === true) return true
  return /\bhub\b|机器人|助手/i.test(String(text ?? ''))
}

export function createFeishuAdapter({ config, log, onInbound, onCardAction, sdk: injectedSdk }) {
  const seen = new SeenSet(1024)
  const chatPeers = new Map() // chatId -> { chatType, name }
  let sdk = injectedSdk
  let client
  let wsClient
  let server
  let stopped = false
  /** 连接状态机：控制台页面直接读它，不再靠"猜"。 */
  const connection = { state: 'idle', error: undefined, since: undefined }

  const peerKeyFor = (chatId) => `feishu:${chatId}`

  async function ensureSdk() {
    if (sdk !== undefined) return sdk
    sdk = await import('@larksuiteoapi/node-sdk')
    return sdk
  }

  function buildClient() {
    if (client !== undefined) return client
    client = new sdk.Client({
      appId: config.appId,
      appSecret: config.appSecret,
      ...(config.domain === undefined ? {} : { domain: config.domain }),
      loggerLevel: sdk.LoggerLevel?.warn ?? 2,
    })
    return client
  }

  /** 平台错误统一转成可读文本，方便进 outbox 的 lastError。 */
  async function call(api, description) {
    try {
      return await api()
    } catch (error) {
      const detail = error?.response?.data ?? error?.message ?? String(error)
      throw new Error(`${description}失败：${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
    }
  }

  async function sendRaw({ chatId, msgType, content, replyTo }) {
    buildClient()
    const body = { msg_type: msgType, content }
    if (replyTo !== undefined) {
      try {
        const response = await call(() => client.im.message.reply({ path: { message_id: replyTo }, data: body }), '回复消息')
        return response?.data?.message_id
      } catch (error) {
        log?.warn(`${String(error)}；改为直接发送`)
      }
    }
    const response = await call(() => client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, ...body },
    }), '发送消息')
    return response?.data?.message_id
  }

  const adapter = {
    id: 'feishu',
    capabilities: { text: true, card: true, updateCard: true, actions: true },

    /** 从 peerKey 取回 chatId。 */
    chatIdOf(peerKey) {
      return String(peerKey).replace(/^feishu:/, '')
    },

    async start() {
      await ensureSdk()
      connection.state = 'connecting'
      connection.error = undefined
      // 注意：这两个是**对象上的方法**，必须经 `adapter.` 调；直接写 startWs()
      // 会抛 ReferenceError（踩过）。所以统一从这里进，别再直接调方法名。
      if (config.mode === 'webhook') return await adapter.startWebhook()
      return await adapter.startWs()
    },

    async startWs() {
      buildClient()
      const dispatcher = new sdk.EventDispatcher({
        loggerLevel: sdk.LoggerLevel?.warn ?? 2,
        // 长连接模式默认不校验签名（SDK 内部 needCheck:false），但如果应用开了
        // 「加密策略」，帧内容仍然是加密的 —— 不传 encryptKey 就会解不出来，
        // 表现是"连接正常但一条事件都收不到"。所以这里一并传上。
        ...(config.encryptKey === undefined || config.encryptKey === '' ? {} : { encryptKey: config.encryptKey }),
        ...(config.verificationToken === undefined || config.verificationToken === '' ? {} : { verificationToken: config.verificationToken }),
      })
      dispatcher.register({
        'im.message.receive_v1': async (data) => {
          try {
            await handleInbound(data)
          } catch (error) {
            log?.error(`处理入站消息失败：${String(error)}`)
          }
          return { code: 0 }
        },
        'card.action.trigger': async (data) => {
          try {
            return await handleCardAction(data)
          } catch (error) {
            log?.error(`处理卡片操作失败：${String(error)}`)
            return { toast: { type: 'error', content: '处理失败，请重试' } }
          }
        },
      })
      wsClient = new sdk.WSClient({
        appId: config.appId,
        appSecret: config.appSecret,
        ...(config.domain === undefined ? {} : { domain: config.domain }),
        loggerLevel: sdk.LoggerLevel?.info ?? 3,
        autoReconnect: true,
        // 这三个回调让控制台能显示"真的连上了"，而不是"我调用了 start()"。
        onReady: () => {
          connection.state = 'connected'
          connection.error = undefined
          connection.since = new Date().toISOString()
          log?.info('飞书长连接已就绪')
          config.onState?.({ state: 'connected', since: connection.since })
        },
        onReconnecting: () => {
          connection.state = 'connecting'
          log?.warn('飞书长连接断开，正在重连…')
          config.onState?.({ state: 'connecting' })
        },
        onReconnected: () => {
          connection.state = 'connected'
          log?.info('飞书长连接已恢复')
          config.onState?.({ state: 'connected', since: connection.since })
        },
        onError: (error) => {
          connection.state = 'error'
          connection.error = String(error?.message ?? error)
          log?.error(`飞书长连接出错：${connection.error}`)
          config.onState?.({ state: 'error', error: connection.error })
        },
      })
      // start() 在内部起重连循环；它返回的 promise 在连接关闭时才会 settle，
      // 所以不能 await 它，否则 apply() 会卡住整个插件加载。
      void wsClient.start({ eventDispatcher: dispatcher }).catch((error) => {
        if (stopped) return
        log?.error(`飞书长连接断开且未能重连：${String(error)}`)
        log?.error('常见原因（按顺序排查）：1) 应用还没发布版本；2) 事件订阅没有选"长连接"；'
          + '3) App ID/Secret 不对；4) 企业安全策略限制了外连。')
      })
      log?.info(`飞书长连接已启动（app ${config.appId}）`)
    },

    async startWebhook() {
      const { createServer } = await import('node:http')
      const dispatcher = new sdk.EventDispatcher({
        verificationToken: config.verificationToken,
        encryptKey: config.encryptKey,
        loggerLevel: sdk.LoggerLevel?.warn ?? 2,
      })
      dispatcher.register({
        'im.message.receive_v1': async (data) => {
          await handleInbound(data)
          return { code: 0 }
        },
        'card.action.trigger': async (data) => await handleCardAction(data),
      })
      const port = config.port ?? 17866
      server = createServer((req, res) => {
        if (req.method !== 'POST' || !(req.url ?? '').startsWith(config.path ?? '/feishu/event')) {
          res.writeHead(404).end('not found')
          return
        }
        let body = ''
        req.on('data', (chunk) => { body += chunk })
        req.on('end', async () => {
          try {
            const data = JSON.parse(body)
            // url_verification 需要原样回 challenge，不能走 dispatcher。
            if (data?.type === 'url_verification') {
              res.writeHead(200, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ challenge: data.challenge }))
              return
            }
            const result = await dispatcher.invoke(data)
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify(result ?? { code: 0 }))
          } catch (error) {
            log?.error(`webhook 处理失败：${String(error)}`)
            res.writeHead(500, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ code: 1, msg: String(error) }))
          }
        })
      })
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, config.host ?? '127.0.0.1', resolve)
      })
      log?.info(`飞书 webhook 已监听 http://${config.host ?? '127.0.0.1'}:${port}${config.path ?? '/feishu/event'}`)
    },

    async sendText({ peerKey, text, replyTo }) {
      const chatId = adapter.chatIdOf(peerKey)
      return await sendRaw({ chatId, msgType: 'text', content: JSON.stringify({ text }), replyTo })
    },

    async sendCard({ peerKey, card, replyTo }) {
      const chatId = adapter.chatIdOf(peerKey)
      // 出站前做一次方言转换：飞书卡片不支持 # 标题和表格。
      return await sendRaw({ chatId, msgType: 'interactive', content: JSON.stringify(normalizeCard(card)), replyTo })
    },

    async updateCard({ messageId, card }) {
      buildClient()
      await call(() => client.im.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(normalizeCard(card)) },
      }), '更新卡片')
    },

    async stop() {
      stopped = true
      connection.state = 'idle'
      try { wsClient?.close?.({ force: true }) } catch { /* 已关闭 */ }
      wsClient = undefined
      if (server !== undefined) {
        await new Promise((resolve) => server.close(resolve))
        server = undefined
      }
    },

    /** webhook 模式下的实际监听地址（端口传 0 时是系统分配的）。 */
    address() {
      const address = server?.address?.()
      return address !== null && typeof address === 'object' ? address : undefined
    },

    /** 控制台与 /status 读这个，而不是自己去问 SDK。 */
    status() {
      const sdkStatus = wsClient?.getConnectionStatus?.()
      return {
        state: connection.state === 'connected' && sdkStatus?.state === 'reconnecting' ? 'connecting' : connection.state,
        error: connection.error,
        since: connection.since,
        reconnects: sdkStatus?.reconnectAttempts,
        mode: config.mode,
      }
    },
  }

  /**
   * 下载消息里的资源（图片/语音/文件）。
   *
   * 飞书的 messageResource.get 返回一个二进制流，且必须显式传 `type`。
   * 这里带字节上限，避免有人发一个 90MB 的视频把内存打满。
   */
  async function downloadResource({ messageId, fileKey, type, maxBytes }) {
    buildClient()
    const limit = maxBytes ?? config.mediaMaxBytes ?? 20 * 1024 * 1024
    const response = await call(() => client.im.v1.messageResource.get({
      params: { type },
      path: { message_id: messageId, file_key: fileKey },
    }), '下载资源')
    const stream = response?.getReadableStream?.()
    if (stream === undefined) throw new Error('下载资源没有返回可读流')
    const chunks = []
    let total = 0
    for await (const chunk of stream) {
      total += chunk.length
      if (total > limit) {
        stream.destroy?.()
        throw new Error(`资源超过 ${Math.round(limit / 1024 / 1024)}MB 上限`)
      }
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  }

  /** 按消息类型把附件取回来，归一化成内核认识的形状。 */
  async function collectMedia(parsed, messageId) {
    const images = []
    const files = []
    let audio
    const notes = []
    const maxBytes = config.mediaMaxBytes ?? 20 * 1024 * 1024

    const fetchInto = async (fileKey, type, onData, label) => {
      if (typeof fileKey !== 'string') return
      try {
        const bytes = await downloadResource({ messageId, fileKey, type, maxBytes })
        onData(bytes)
      } catch (error) {
        log?.warn(`${label}下载失败：${String(error)}`)
        notes.push(`${label}没能下载下来，可能太大或已过期`)
      }
    }

    if (parsed.kind === 'image') {
      await fetchInto(parsed.imageKey, 'image', (bytes) => {
        images.push({ mediaType: sniffImageMime(bytes), data: bytes.toString('base64') })
      }, '图片')
    } else if (parsed.kind === 'post') {
      for (const key of parsed.imageKeys ?? []) {
        await fetchInto(key, 'image', (bytes) => {
          images.push({ mediaType: sniffImageMime(bytes), data: bytes.toString('base64') })
        }, '图片')
      }
    } else if (parsed.kind === 'audio') {
      await fetchInto(parsed.fileKey, 'file', (bytes) => {
        audio = { data: bytes, format: parsed.format ?? 'ogg', durationMs: parsed.durationMs }
      }, '语音')
    } else if (parsed.kind === 'file') {
      await fetchInto(parsed.fileKey, 'file', (bytes) => {
        files.push({ data: bytes, name: parsed.fileName })
      }, '文件')
    }
    return { images, files, audio, notes }
  }

  async function handleInbound(data) {
    const message = data?.message
    if (message === undefined) return
    if (data?.sender?.sender_type === 'app') return // 忽略机器人自己发的
    const messageId = message.message_id
    if (typeof messageId !== 'string') return
    // 飞书 3 秒不收就重投；去重必须在最前面。
    if (!seen.add(messageId)) {
      log?.info(`忽略重投的消息 ${messageId}`)
      return
    }
    const chatType = message.chat_type === 'group' ? 'group' : 'p2p'
    const parsed = parseMessage(message)
    if (parsed.kind === 'unsupported') {
      log?.info(`收到暂不支持的消息类型 ${String(message.message_type)}（${messageId}）`)
      // 不建会话、不消耗模型回合，直接回一句 —— 否则用户只会觉得"机器人没反应"。
      void adapter.sendText({
        peerKey: peerKeyFor(message.chat_id),
        text: `这个类型的消息暂时处理不了（${String(message.message_type)}）。表情包、合并转发消息和卡片里的资源飞书接口本身不提供下载。`,
        replyTo: messageId,
      }).catch(() => {})
      return
    }
    const text = parsed.kind === 'text' || parsed.kind === 'post'
      ? String(parsed.text ?? '').replace(/\s+/g, ' ').trim()
      : ''
    // 群聊里"没文字又没被 @ "的图片/语音不该触发 agent。
    const mentioned = (message.mentions?.length ?? 0) > 0
    if (!shouldHandleChat({ chatType, config, text, mentioned })) {
      log?.info(`忽略 ${chatType} 消息（未通过 chat 策略）`)
      return
    }
    const media = await collectMedia(parsed, messageId)
    if (text === '' && media.images.length === 0 && media.audio === undefined && media.files.length === 0) {
      log?.info(`消息 ${messageId} 没有可读内容，已忽略`)
      return
    }
    chatPeers.set(message.chat_id, { chatType })
    await onInbound({
      platform: 'feishu',
      peerKey: peerKeyFor(message.chat_id),
      chatId: message.chat_id,
      chatType,
      messageId,
      text,
      images: media.images,
      files: media.files,
      audio: media.audio,
      notes: media.notes,
      senderId: data?.sender?.sender_id?.open_id,
      replyTo: messageId,
      raw: data,
    })
  }

  async function handleCardAction(data) {
    const chatId = data?.open_chat_id ?? data?.context?.open_chat_id
    const value = data?.action?.value
    if (chatId === undefined) return { toast: { type: 'warning', content: '缺少会话上下文' } }
    const result = await onCardAction({
      platform: 'feishu',
      peerKey: peerKeyFor(chatId),
      chatId,
      operatorId: data?.operator?.open_id,
      value,
      messageId: data?.open_message_id,
    })
    return { toast: { type: 'info', content: result?.toast ?? '已处理' } }
  }

  return adapter
}
