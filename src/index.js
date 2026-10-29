/**
 * dsh-channel-hub —— 把 IM 变成 DSH 的远程控制面。
 *
 * 结构（内核 + 适配器）：
 *
 *   飞书/企业微信/任意 webhook            ← 适配器只做收发
 *            ↓ ↑
 *   ┌──────────────────────────────────┐
 *   │ 路由表  会话映射 + 代次            │
 *   │ 队列    同一聊天窗口严格串行        │  ← 内核，与平台无关
 *   │ 桥      会话创建 / followup / 收字  │
 *   │ 卡片    审批与提问的应答方          │
 *   │ 出站    失败重试（磁盘队列）        │
 *   └──────────────────────────────────┘
 *            ↓ ↑
 *        DSH agents / session/event
 *
 * 三条安全默认值：
 *  1. 白名单为空 ⇒ 谁都不回（fail closed）。
 *  2. 插件加载失败、适配器连不上，都不抛到宿主 —— 只记日志。
 *  3. 状态文件只存映射与摘要，消息原文按天进 journal（可关）。
 */
import { dirname, join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createLogger } from './log.js'
import { loadConfig, patchConfigFile, resolveStateDir, validateConfig } from './config.js'
import { SessionRouter, platformOf } from './router.js'
import { AgentBridge } from './bridge.js'
import { PeerQueue } from './queue.js'
import { CardGate } from './cards.js'
import { createOutbox } from './outbox.js'
import { handleCommand } from './commands.js'
import { SeenSet, appendJsonl } from './store.js'
import { buildPromptParts } from './media.js'
import { createAdminServer, tailLog } from './admin.js'
import {
  DEFAULT_CHUNK_LIMIT, buildApprovalCard, buildCard, buildProgressCard, buildQuestionCard,
  chunkText, preferCard, toPlainText,
} from './format.js'

export const name = 'dsh-channel-hub'
/** 不硬依赖：agents 缺失时插件也应该能加载并给出可读的报错。 */
export const inject = []

/**
 * 组装一个 hub（不启动）。
 *
 * 独立于 cordis 的 apply 而存在，是为了让单测和 bin/demo.mjs 能用假宿主
 * 跑同一套内核代码 —— 测试里注入假适配器，生产里注入真适配器。
 */
export function createHub({ ctx, config, stateDir, log, adapters = new Map() }) {
  const behavior = config.behavior ?? {}
  const chunkLimit = behavior.chunkLimit ?? DEFAULT_CHUNK_LIMIT
  const seen = new SeenSet(1024)
  const warned = new Set()

  const router = new SessionRouter({ file: join(stateDir, 'sessions.json'), log })
  const queue = new PeerQueue({ maxDepth: behavior.maxQueueDepth ?? 8, log })
  /** 见过的聊天窗口（含未授权的），控制台用它一键放行。 */
  const discovered = new Map()
  const bridge = new AgentBridge({
    ctx,
    router,
    cwd: config.agent?.cwd,
    route: () => (config.agent?.provider && config.agent?.model
      ? { provider: config.agent.provider, model: config.agent.model }
      : undefined),
    log,
    maxWaitMs: behavior.maxTurnMs,
    progressAfterMs: behavior.progressAfterMs,
  })

  const journalFile = () => join(stateDir, 'journal', `journal-${new Date().toISOString().slice(0, 10)}.jsonl`)
  function journal(record) {
    if (behavior.journal === false) return
    appendJsonl(journalFile(), { at: new Date().toISOString(), ...record }, (error) => {
      log?.warn(`journal 写入失败：${String(error)}`)
    })
  }

  function adapterFor(peerKey) {
    return adapters.get(platformOf(peerKey))
  }

  /** 出站队列的发送实现：所有重试都从这里过。 */
  async function rawSend(item) {
    const adapter = adapterFor(item.peerKey)
    if (adapter === undefined) throw new Error(`没有为 ${item.peerKey} 注册适配器`)
    if (item.kind === 'card') return await adapter.sendCard({ peerKey: item.peerKey, card: item.card, replyTo: item.replyTo })
    return await adapter.sendText({ peerKey: item.peerKey, text: item.text, replyTo: item.replyTo })
  }

  const outbox = createOutbox({ file: join(stateDir, 'outbox.json'), send: rawSend, log })

  const notifier = {
    async sendText(peerKey, text) {
      const chunks = chunkText(text, chunkLimit)
      for (const chunk of chunks) await outbox.deliver({ kind: 'text', peerKey, text: chunk })
    },
    async sendApprovalCard(peerKey, info) {
      const pending = gate.pendingFor(peerKey)
      const card = buildApprovalCard({
        ...info,
        index: pending.length,
        total: pending.length,
      })
      await outbox.deliver({ kind: 'card', peerKey, card })
    },
    async sendQuestionCard(peerKey, info) {
      const built = buildQuestionCard(info)
      if (built.card !== undefined) await outbox.deliver({ kind: 'card', peerKey, card: built.card })
      else await notifier.sendText(peerKey, built.text)
    },
  }

  const gate = (behavior.allowApprovalCards === false && behavior.allowQuestions === false)
    ? undefined
    : new CardGate({
        ctx,
        router,
        log: log?.child('cards'),
        notifier,
        timeoutMs: behavior.cardTimeoutMs,
        dismissGuiCard: behavior.dismissGuiCard !== false,
      })

  /** 直接发一条文本（命令回执这类"必须立刻到"的消息，走同步路径不进队列）。 */
  async function sendImmediate(peerKey, text, replyTo) {
    const adapter = adapterFor(peerKey)
    if (adapter === undefined) return
    try {
      await adapter.sendText({ peerKey, text, replyTo })
    } catch (error) {
      log?.warn(`同步发送失败，转入队列：${String(error)}`)
      await outbox.deliver({ kind: 'text', peerKey, text })
    }
  }

  function authorized(peerKey) {
    if (config.security?.allowAll === true) return true
    const allow = Array.isArray(config.security?.allowPeers) ? config.security.allowPeers : []
    return allow.includes(peerKey)
  }

  /** 未授权时只提示一次，避免刷屏；但每次都记日志（排障要看得到）。 */
  async function rejectUnauthorized(msg) {
    log?.warn(`拒绝未授权的会话 ${msg.peerKey}（发送者 ${String(msg.senderId)}）`)
    if (warned.has(msg.peerKey)) return
    warned.add(msg.peerKey)
    await sendImmediate(msg.peerKey, [
      '这个聊天窗口还没有被授权使用 DSH。',
      '在「DSH 通道中枢」控制台第 3 步点一下「允许」就行，不用重启：',
      `${msg.peerKey}`,
      '（或者命令行：node bin/cli.mjs allow <上面这串>）',
    ].join('\n'), msg.replyTo)
  }

  /** 一轮对话：进度卡 → 等结果 → 落成最终卡片。 */
  async function runTurn(msg, parts, headline) {
    const startedAt = Date.now()
    let cardId
    const title = String(headline ?? msg.text).replace(/\s+/g, ' ').trim().slice(0, 30) || '任务'
    if (behavior.progressCards !== false) {
      try {
        cardId = await adapterFor(msg.peerKey)?.sendCard({
          peerKey: msg.peerKey,
          card: buildProgressCard({ title, status: '已收到，正在处理…' }),
        })
      } catch (error) {
        log?.warn(`进度卡发送失败（不影响回答）：${String(error)}`)
      }
    }
    const onProgress = async (note) => {
      if (cardId === undefined) return
      try {
        await adapterFor(msg.peerKey)?.updateCard({
          messageId: cardId,
          card: buildProgressCard({ title, status: note }),
        })
      } catch {
        /* 卡片刷新失败无所谓，最终答案还会发 */
      }
    }

    let result
    try {
      result = await bridge.deliver({ peerKey: msg.peerKey, text: msg.text, parts, title, onProgress })
    } catch (error) {
      log?.error(`回合执行失败：${String(error)}`)
      result = { text: '', sessionId: undefined, error: String(error?.message ?? error) }
    }
    const elapsed = Math.round((Date.now() - startedAt) / 1000)
    await finalizeReply({ msg, result, cardId, elapsed, title })
    router.noteTurn(msg.peerKey)
    journal({
      dir: 'out', peerKey: msg.peerKey, sessionId: result.sessionId,
      elapsedMs: Date.now() - startedAt, chars: (result.text ?? '').length,
      error: result.error,
    })
  }

  async function finalizeReply({ msg, result, cardId, elapsed, title }) {
    const body = String(result.text ?? '').trim()
    const failed = result.error !== undefined
    const footer = `用时 ${elapsed}s${result.sessionId === undefined ? '' : ` · ${result.sessionId}`}`
    if (failed) {
      const card = buildCard({
        title: '执行失败',
        color: 'red',
        markdown: `**原因**：${result.error}\n\n${body === '' ? '' : body}`,
        footer,
      })
      if (cardId !== undefined) {
        try {
          await adapterFor(msg.peerKey)?.updateCard({ messageId: cardId, card })
          return
        } catch { /* 落到下面重新发 */ }
      }
      await outbox.deliver({ kind: 'card', peerKey: msg.peerKey, card })
      return
    }
    if (body === '') {
      const card = buildCard({ title, color: 'grey', markdown: '这一轮没有产生可读输出。', footer })
      if (cardId !== undefined) {
        try {
          await adapterFor(msg.peerKey)?.updateCard({ messageId: cardId, card })
          return
        } catch { /* 继续 */ }
      }
      await outbox.deliver({ kind: 'card', peerKey: msg.peerKey, card })
      return
    }

    const chunks = chunkText(body, chunkLimit)
    const asCard = preferCard(body)
    // 第一段尽量复用已发出的进度卡：一张卡从"处理中"长成完整答案，聊天窗口更干净。
    if (cardId !== undefined) {
      const first = chunks[0]
      const card = buildCard({
        title,
        color: 'green',
        markdown: first,
        footer: chunks.length > 1 ? `${footer} · 还有 ${chunks.length - 1} 段` : footer,
      })
      try {
        await adapterFor(msg.peerKey)?.updateCard({ messageId: cardId, card })
        // 后续段落必须和第一段用同一种渲染方式：走卡片才能渲染 markdown，
        // 退回纯文本就要先剥掉装饰 —— 直接把原文当 text 发，用户会看到 **星号**。
        for (const [index, extra] of chunks.slice(1).entries()) {
          await outbox.deliver({
            kind: 'card',
            peerKey: msg.peerKey,
            card: buildCard({
              title: `${title}（续 ${index + 2}/${chunks.length}）`,
              color: 'green',
              ...(asCard ? { markdown: extra } : { markdown: toPlainText(extra) }),
              ...(index === chunks.length - 2 ? { footer } : {}),
            }),
          })
        }
        return
      } catch (error) {
        log?.warn(`更新进度卡失败，改为重发：${String(error)}`)
      }
    }
    for (const [index, chunk] of chunks.entries()) {
      if (asCard) {
        await outbox.deliver({
          kind: 'card',
          peerKey: msg.peerKey,
          card: buildCard({ title: index === 0 ? title : `${title}（续）`, color: 'green', markdown: chunk, footer: index === chunks.length - 1 ? footer : undefined }),
        })
      } else {
        await outbox.deliver({ kind: 'text', peerKey: msg.peerKey, text: toPlainText(chunk) })
      }
    }
  }

  /** 入站主干：白名单 → 去重 → 命令 → 卡片应答 → agent。 */
  async function handleInbound(rawMsg) {
    if (typeof rawMsg?.peerKey !== 'string') return
    // 图片/语音消息可以没有文字，统一成空串，后面的判断只看"有没有内容"。
    const msg = { ...rawMsg, text: typeof rawMsg.text === 'string' ? rawMsg.text : '' }
    // 先登记：哪怕没授权，控制台也要能看到"有人来找过你"，才能一键放行。
    discovered.set(msg.peerKey, {
      peerKey: msg.peerKey,
      at: new Date().toISOString(),
      preview: (msg.text || (msg.images?.length ? '［图片］' : msg.audio ? '［语音］' : '［消息］')).slice(0, 60),
    })
    journal({ dir: 'in', peerKey: msg.peerKey, messageId: msg.messageId, senderId: msg.senderId, chars: msg.text.length })
    if (!authorized(msg.peerKey)) return await rejectUnauthorized(msg)
    if (msg.messageId !== undefined && !seen.add(msg.messageId)) {
      log?.info(`忽略重复消息 ${msg.messageId}`)
      return
    }
    // 命令和卡片应答只对文字消息生效：一条图片不该被当成"审批回复"消费掉。
    if (msg.text !== '') {
      const command = await handleCommand({
        text: msg.text,
        peerKey: msg.peerKey,
        router,
        bridge,
        gate,
        adapters,
        outbox,
      })
      if (command.handled) {
        await sendImmediate(msg.peerKey, command.reply ?? '（无输出）', msg.replyTo)
        return
      }
      if (gate !== undefined) {
        const cardReply = await gate.answerFromText(msg.peerKey, msg.text)
        if (cardReply.handled) {
          await sendImmediate(msg.peerKey, cardReply.reply ?? '（无输出）', msg.replyTo)
          return
        }
      }
    }
    if (queue.isBusy(msg.peerKey)) {
      await sendImmediate(msg.peerKey, '⏳ 上一个任务还在跑，这条已经排队。发 /stop 可以中断当前任务。', msg.replyTo)
    }
    // 图片/语音/文件：先换成 durable 附件引用，再和文字一起交给 agent。
    let parts
    let headline
    const hasMedia = (msg.images?.length ?? 0) > 0 || msg.audio !== undefined || (msg.files?.length ?? 0) > 0
    if (hasMedia) {
      try {
        const built = await buildPromptParts({
          message: msg,
          attachments: ctx.get('attachments'),
          speech: behavior.media?.audio === false ? undefined : ctx.get('speechToText'),
          limits: behavior.media ?? {},
          log,
        })
        parts = built.parts
        headline = built.title
        if (built.notes.length > 0) {
          await sendImmediate(msg.peerKey, `⚠️ ${built.notes.join('\n⚠️ ')}`, msg.replyTo)
        }
        journal({
          dir: 'media', peerKey: msg.peerKey, messageId: msg.messageId,
          images: msg.images?.length ?? 0, files: msg.files?.length ?? 0, audio: msg.audio !== undefined,
        })
      } catch (error) {
        log?.error(`媒体处理失败：${String(error)}`)
        await sendImmediate(msg.peerKey, `媒体处理失败：${String(error?.message ?? error)}`, msg.replyTo)
        return
      }
    }
    try {
      await queue.enqueue(msg.peerKey, () => runTurn(msg, parts, headline))
    } catch (error) {
      if (error?.code === 'QUEUE_FULL') {
        await sendImmediate(msg.peerKey, '队列满了，稍等一会儿再发。', msg.replyTo)
        return
      }
      log?.error(`入站处理失败：${String(error)}`)
      await sendImmediate(msg.peerKey, `出错了：${String(error?.message ?? error)}`, msg.replyTo)
    }
  }

  /** 卡片按钮回调。 */
  async function handleCardAction(action) {
    if (gate === undefined) return { toast: '审批卡片未启用' }
    if (!authorized(action.peerKey)) return { toast: '这个会话未授权' }
    return await gate.answerFromAction({ peerKey: action.peerKey, value: action.value })
  }

  /**
   * 核心接通：订阅 session/event、挂上审批监听。
   *
   * **必须和"启动适配器"分开**：配置不全时（首次安装的常态）适配器不该起，
   * 但控制台会让人现场补齐配置、现场连接 —— 那一刻如果事件订阅还没挂上，
   * 回合会永远等不到回复。这个坑是真实踩到的，所以这里是幂等的单独一步。
   */
  let coreStarted = false
  async function startCore() {
    if (coreStarted) return
    coreStarted = true
    bridge.start()
    gate?.install()
    void outbox.flush()
  }

  async function startAdapters() {
    for (const [id, adapter] of adapters) {
      try {
        await adapter.start()
        log?.info(`适配器已启动：${id}`)
      } catch (error) {
        log?.error(`适配器 ${id} 启动失败：${String(error)}`)
      }
    }
  }

  async function start() {
    await startCore()
    await startAdapters()
  }

  async function stop() {
    // 给在跑的回合一点时间收尾，但绝不让关闭流程被它拖住。
    let guard
    try {
      await Promise.race([
        queue.drain(),
        new Promise((resolve) => { guard = setTimeout(resolve, 5_000); guard.unref?.() }),
      ])
    } catch { /* 关闭时排空失败无所谓 */ } finally {
      if (guard !== undefined) clearTimeout(guard)
    }
    for (const [id, adapter] of adapters) {
      try {
        await adapter.stop()
      } catch (error) {
        log?.warn(`适配器 ${id} 关闭失败：${String(error)}`)
      }
    }
    gate?.dispose()
    bridge.dispose()
    outbox.close()
    log?.info('通道中枢已停止')
  }

  return {
    router,
    bridge,
    gate,
    outbox,
    queue,
    adapters,
    discovered,
    start,
    startCore,
    startAdapters,
    stop,
    handleInbound,
    handleCardAction,
    stats: () => ({
      peers: router.list().length,
      outbox: outbox.size(),
      adapters: [...adapters.keys()],
    }),
  }
}

/**
 * cordis 插件入口。
 *
 * 注意：这里**不抛错**。配置不对时记一条 error 日志，但**控制台页面照常启动** ——
 * 用户第一次用的时候配置一定是不全的，那个页面正是用来把配置补齐的。
 */
export function apply(ctx, patchConfig) {
  const stateDir = resolveStateDir({ config: patchConfig })
  mkdirSync(stateDir, { recursive: true })
  const logger = createLogger({
    dir: join(stateDir, 'logs'),
    hostLog: (line) => ctx.logger?.info?.(line),
    hostErr: (line) => ctx.logger?.warn?.(line),
  })
  const log = logger.child('hub')

  const config = loadConfig({ patchConfig, stateDir, env: process.env })
  const { problems, warnings } = validateConfig(config)
  for (const warning of warnings) log.warn(warning)

  /** @type {Map<string, any>} */
  const adapters = new Map()
  /** 飞书运行态：控制台展示与热切换都读这里。 */
  const feishuRuntime = {
    state: 'idle',
    error: undefined,
    since: undefined,
    botName: config.adapters?.feishu?.botName,
  }
  /** @type {any} */
  let hub
  const feishuConfig = () => ({
    ...config.adapters.feishu,
    onState: (next) => {
      feishuRuntime.state = next.state === 'error' ? 'error' : next.state
      feishuRuntime.error = next.error
      if (next.state === 'connected' && feishuRuntime.since === undefined) feishuRuntime.since = next.since
      admin?.publish('state', buildSnapshot())
    },
  })

  function buildFeishu() {
    return lazyAdapter('feishu', async () => {
      // 带版本串的动态 import：每次连接都重新求值适配器模块。
      // 这不是花活 —— ESM 会把模块缓存住，改完 adapters/feishu.js 如果不重启
      // DSH，点"连接"拿到的还是旧代码。加上 `?v=` 之后，适配器层的修复只要在
      // 控制台点一次「断开 → 连接」就生效（插件装配层改动仍需重启）。
      const mod = await import(`./adapters/feishu.js?v=${Date.now()}`)
      return mod.createFeishuAdapter({
        config: feishuConfig(),
        log: logger.child('feishu'),
        onInbound: (msg) => hub.handleInbound(msg),
        onCardAction: (action) => hub.handleCardAction(action),
      })
    })
  }

  async function stopFeishu() {
    const existing = adapters.get('feishu')
    if (existing === undefined) return
    try { await existing.stop() } catch (error) { log.warn(`停止飞书通道失败：${String(error)}`) }
    adapters.delete('feishu')
    feishuRuntime.state = 'idle'
    feishuRuntime.since = undefined
  }

  /** 热启动：不重启 DSH，直接把长连接拉起来。 */
  async function connectFeishu() {
    if (config.adapters.feishu.enabled !== true) return { ok: false, error: '配置里 feishu.enabled 还是 false' }
    // 事件订阅必须先于连接：否则连上之后第一轮就收不到回复。
    await hub.startCore()
    await stopFeishu()
    feishuRuntime.state = 'starting'
    feishuRuntime.error = undefined
    const adapter = buildFeishu()
    adapters.set('feishu', adapter)
    try {
      await adapter.start()
    } catch (error) {
      feishuRuntime.state = 'error'
      feishuRuntime.error = String(error?.message ?? error)
      log.error(`飞书通道启动失败：${feishuRuntime.error}`)
      return { ok: false, error: feishuRuntime.error }
    }
    // 长连接的 start() 只是"开始连"，真正的就绪由 onReady 回调推进。
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      const status = adapter.status?.() ?? { state: feishuRuntime.state }
      if (status.state === 'connected' || status.state === 'error') break
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    const finalState = adapter.status?.() ?? {}
    if (finalState.state === 'connected') {
      feishuRuntime.state = 'connected'
      feishuRuntime.since = finalState.since ?? new Date().toISOString()
      return { ok: true }
    }
    if (finalState.state === 'error') {
      feishuRuntime.state = 'error'
      feishuRuntime.error = finalState.error
      return { ok: false, error: finalState.error }
    }
    // 还没连上也不算失败：SDK 会自己重连，页面能继续看到"连接中"。
    feishuRuntime.state = 'starting'
    return { ok: true, pending: true }
  }

  async function setCredentials(input) {
    const appId = String(input.appId ?? '').trim()
    const appSecret = String(input.appSecret ?? '').trim()
    const mode = input.mode === 'webhook' ? 'webhook' : 'ws'
    if (appId === '' || appSecret === '') return { ok: false, error: 'App ID 和 App Secret 都要填' }
    const { verifyFeishuCredentials } = await import('./admin.js')
    const verified = await verifyFeishuCredentials({ appId, appSecret, domain: input.domain })
    if (verified.ok !== true) return { ok: false, error: verified.error }
    const patch = {
      adapters: { feishu: { enabled: true, appId, appSecret, mode, ...(verified.bot?.name === undefined ? {} : { botName: verified.bot.name }) } },
    }
    patchConfigFile(stateDir, patch)
    config.adapters.feishu = { ...config.adapters.feishu, ...patch.adapters.feishu }
    feishuRuntime.botName = verified.bot?.name
    log.info(`飞书凭证已保存（${appId}${verified.bot?.name === undefined ? '' : ` · ${verified.bot.name}`}，${mode}）`)
    return { ok: true, bot: verified.bot }
  }

  function allowPeer(peerKey) {
    const list = Array.isArray(config.security.allowPeers) ? [...config.security.allowPeers] : []
    if (!list.includes(peerKey)) list.push(peerKey)
    config.security.allowPeers = list
    patchConfigFile(stateDir, { security: { allowPeers: list } })
    log.info(`已放行 ${peerKey}`)
  }

  function disallowPeer(peerKey) {
    const list = (Array.isArray(config.security.allowPeers) ? config.security.allowPeers : []).filter((item) => item !== peerKey)
    config.security.allowPeers = list
    patchConfigFile(stateDir, { security: { allowPeers: list } })
    log.info(`已移除 ${peerKey}`)
  }

  function setAllowAll(value) {
    config.security.allowAll = value === true
    patchConfigFile(stateDir, { security: { allowAll: config.security.allowAll } })
    log.warn(`allowAll 已设为 ${String(config.security.allowAll)}`)
  }

  /** 控制台用的快照：永远不返回明文凭证。 */
  function buildSnapshot() {
    const feishu = config.adapters.feishu
    const allowed = new Set(Array.isArray(config.security.allowPeers) ? config.security.allowPeers : [])
    const peers = new Map()
    for (const entry of hub?.router?.list?.() ?? []) {
      peers.set(entry.peerKey, {
        peerKey: entry.peerKey,
        allowed: allowed.has(entry.peerKey),
        title: entry.title,
        turns: entry.turns ?? 0,
        lastSeenAt: entry.lastSeenAt,
      })
    }
    for (const item of hub?.discovered?.values?.() ?? []) {
      const existing = peers.get(item.peerKey)
      peers.set(item.peerKey, {
        peerKey: item.peerKey,
        allowed: allowed.has(item.peerKey),
        title: existing?.title,
        turns: existing?.turns ?? 0,
        lastSeenAt: existing?.lastSeenAt ?? item.at,
        preview: item.preview,
      })
    }
    return {
      stateDir,
      adminUrl: admin?.url,
      feishu: {
        configured: typeof feishu.appId === 'string' && /^cli_[0-9a-zA-Z]{8,}$/.test(feishu.appId) && !feishu.appId.startsWith('cli_xxxx'),
        appId: feishu.appId ?? '',
        mode: feishu.mode ?? 'ws',
        enabled: feishu.enabled === true,
        state: feishuRuntime.state,
        error: feishuRuntime.error,
        since: feishuRuntime.since,
        botName: feishuRuntime.botName,
        connection: adapters.get('feishu')?.status?.() ?? {},
      },
      security: { allowAll: config.security.allowAll === true, allowPeers: [...allowed] },
      stats: hub?.stats?.() ?? { peers: 0, outbox: 0, adapters: [...adapters.keys()] },
      pending: hub?.gate?.list?.() ?? [],
      peers: [...peers.values()].sort((a, b) => String(b.lastSeenAt ?? '').localeCompare(String(a.lastSeenAt ?? ''))),
      logs: tailLog(join(stateDir, 'logs'), 40),
    }
  }

  const admin = config.admin?.enabled === false ? undefined : createAdminServer({
    port: config.admin?.port ?? 17867,
    host: config.admin?.host ?? '127.0.0.1',
    htmlFile: join(here, 'admin.html'),
    // token 落盘：重启 DSH 后旧地址仍然有效，用户只需要刷新页面。
    tokenFile: join(stateDir, 'admin-token'),
    log: logger.child('admin'),
    getSnapshot: async () => buildSnapshot(),
    setCredentials,
    connect: connectFeishu,
    disconnect: async () => { await stopFeishu(); return { ok: true } },
    allowPeer,
    disallowPeer,
    setAllowAll,
  })

  hub = createHub({ ctx, config, stateDir, log, adapters })

  if (config.adapters?.feishu?.enabled === true) adapters.set('feishu', buildFeishu())
  if (config.adapters?.mock?.enabled === true) adapters.set('mock', createMockLazy({ log: logger.child('mock'), getHub: () => hub }))

  let disposed = false
  const dispose = async () => {
    if (disposed) return
    disposed = true
    try {
      await admin?.stop()
      await hub.stop()
    } finally {
      logger.close()
    }
  }
  ctx.effect?.(() => () => { void dispose() })
  // 测试与嵌入方需要一个明确的"全停"入口（会一起关掉控制台）。
  hub.dispose = dispose
  hub.admin = admin

  if (problems.length > 0) {
    log.error(`配置不完整，通道未启动（共 ${problems.length} 项），但控制台可以继续用：`)
    for (const problem of problems) log.error(`· ${problem}`)
    log.error(`配置文件：${join(stateDir, 'config.json')}`)
  }

  void (async () => {
    // 控制台先起：它就是用来补齐配置的入口，不能等通道。
    if (admin !== undefined) {
      const started = await admin.start()
      if (started !== undefined) log.info(`打开控制台完成配置：${started.url}`)
    }
    // 核心先接通（事件订阅 / 审批监听），配置齐了再启动适配器。
    await hub.startCore()
    if (problems.length === 0) {
      log.info(`通道中枢启动：stateDir=${stateDir}，适配器=${[...adapters.keys()].join('、') || '（无）'}`)
      await hub.startAdapters()
      if (adapters.has('feishu')) {
        const status = adapters.get('feishu').status?.() ?? {}
        if (status.state === 'connected') feishuRuntime.state = 'connected'
        else if (status.state === 'error') Object.assign(feishuRuntime, { state: 'error', error: status.error })
        else feishuRuntime.state = 'starting'
      }
    }
  })().catch((error) => log.error(`启动失败：${String(error)}`))

  return hub
}

/** 插件目录（admin.html 相对它定位，asar 里也能用）。 */
const here = dirname(fileURLToPath(import.meta.url))

/** 飞书适配器由 apply() 里的 buildFeishu() 惰性创建（控制台要能热重建它）。 */

function createMockLazy({ log, getHub }) {
  let inner
  const ensure = () => {
    if (inner !== undefined) return inner
    inner = import('./adapters/mock.js').then((mod) => mod.createMockAdapter({
      log,
      onInbound: (msg) => getHub().handleInbound(msg),
      onCardAction: (action) => getHub().handleCardAction(action),
    }))
    return inner
  }
  return lazyAdapter('mock', ensure)
}

/** 惰性适配器的统一外壳：内部实现按需加载，接口保持同步。 */
function lazyAdapter(id, ensure) {
  /** @type {any} */
  let resolved
  const get = async () => {
    if (resolved !== undefined) return resolved
    resolved = await ensure()
    return resolved
  }
  return {
    id,
    capabilities: { text: true, card: true, updateCard: true, actions: true },
    async start() { return await (await get()).start() },
    async stop() {
      // 从未启动过就不必调用 stop（避免为一个没连上的适配器建连接）。
      if (resolved === undefined) return
      return await resolved.stop()
    },
    async sendText(args) { return await (await get()).sendText(args) },
    async sendCard(args) { return await (await get()).sendCard(args) },
    async updateCard(args) { return await (await get()).updateCard(args) },
    /** 连接状态：没创建过就是 idle，不替它编一个"已连接"。 */
    status() {
      return resolved?.status?.() ?? { state: 'idle' }
    },
  }
}
