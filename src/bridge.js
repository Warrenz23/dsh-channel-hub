/**
 * DSH 会话桥：把"一个聊天窗口"接到"一个 DSH agent 会话"。
 *
 * 三个关键事实（都是照着宿主源码确认过的，不是猜的）：
 *  1. 入站只有 `agent.followup(userMessage)` 一条路 —— 它排队到下一轮并**唤醒**
 *     驱动。`inject()` 不唤醒，`steer()` 只在下一个 step 边界生效。
 *  2. 出站没有投递 seam。唯一稳定、可重放的来源是 durable 的
 *     `session/event` 里的 `assistant/message`。逐字流（`agent/assistant-stream`）
 *     是进程内的、跨重启会丢，只适合做"正在输入"。
 *  3. `agent.followup()` 在已 dispose 的 agent 上**静默接受、消息丢失**。
 *     所以每次投递前必须 `ctx.agents.get(id) === agent` 校验存活。
 *
 * 这套实现因此是"订阅 + 区间"模型：投递前记下 seq 基线，只接受基线之后
 * 新开的一轮 `turn/start`，并在属于这一轮的 `turn/end` 收尾。
 */
import { createHash, randomUUID } from 'node:crypto'

/** 从事件流里取出 settled 的助手文本（与宿主 stream 的两种形态都兼容）。 */
export function streamText(stream) {
  if (!Array.isArray(stream)) return ''
  let out = ''
  for (const entry of stream) {
    if (entry?.type === 'text-chunks' && Array.isArray(entry.texts)) out += entry.texts.join('')
    else if (entry?.type === 'chunk' && entry.chunk?.type === 'text-delta' && typeof entry.chunk.text === 'string') {
      out += entry.chunk.text
    }
  }
  return out
}

/** 从 assistant message 的内容块里取文本。 */
export function messageText(message) {
  if (!Array.isArray(message?.content)) return ''
  let out = ''
  for (const block of message.content) {
    if (block?.type === 'text' && typeof block.text === 'string') out += block.text
  }
  return out
}

let createUserMessageRef
/**
 * 拿宿主的 createUserMessage。
 *
 * 它是 `@deepseek-ai/dsh-llm` 的导出，但在插件目录里不一定能解析到（取决于
 * profile 的依赖提升方式）。解析不到就自己造一个等价结构：role + content +
 * source + 一个新的 uuid，这正是宿主 createMessage 做的事。
 */
export async function resolveCreateUserMessage() {
  if (createUserMessageRef !== undefined) return createUserMessageRef
  try {
    const mod = await import('@deepseek-ai/dsh-llm')
    createUserMessageRef = typeof mod.createUserMessage === 'function' ? mod.createUserMessage : fallbackCreateUserMessage
  } catch {
    createUserMessageRef = fallbackCreateUserMessage
  }
  return createUserMessageRef
}

function fallbackCreateUserMessage(input) {
  return Object.freeze({ ...input, role: 'user', id: randomUUID() })
}

/** 会话事件里"这一轮结束了"的判定。 */
const SETTLED_TYPES = new Set(['assistant/message', 'assistant/attempt'])

/** 一轮的上限保护：超时不算失败，把已有文本交回去。 */
const DEFAULT_MAX_WAIT_MS = 30 * 60_000

export class AgentBridge {
  /**
   * @param {object} options
   * @param {any} options.ctx        cordis 上下文
   * @param {any} options.router     SessionRouter
   * @param {string} [options.cwd]   agent 工作目录
   * @param {() => ({provider: string, model: string} | undefined)} [options.route]
   * @param {any} options.log
   * @param {number} [options.maxWaitMs]
   * @param {number} [options.progressAfterMs]
   */
  constructor({ ctx, router, cwd, route, log, maxWaitMs = DEFAULT_MAX_WAIT_MS, progressAfterMs = 25_000 }) {
    this.ctx = ctx
    this.router = router
    this.cwd = cwd
    this.routeOption = route
    this.log = log
    this.maxWaitMs = maxWaitMs
    this.progressAfterMs = progressAfterMs
    /** @type {Map<string, any>} sessionId -> 已 attach 的 agent 记录 */
    this.records = new Map()
    /** @type {Map<string, Promise<any>>} 并发 attach 去重 */
    this.attaching = new Map()
    /** @type {Map<string, any>} sessionId -> 当前等待中的回合 */
    this.waiters = new Map()
    this.offSessionEvent = undefined
    this.workspacePromise = undefined
    this.disposed = false
  }

  /** 挂上 durable 事件订阅。返回 dispose。 */
  start() {
    if (this.offSessionEvent !== undefined) return
    this.offSessionEvent = this.ctx.on('session/event', (session, event) => {
      try {
        this.#onEvent(session, event)
      } catch (error) {
        this.log?.warn(`处理会话事件失败：${String(error)}`)
      }
    })
    this.log?.info('已订阅 session/event，等待回复文本')
  }

  dispose() {
    this.disposed = true
    this.offSessionEvent?.()
    this.offSessionEvent = undefined
    for (const waiter of this.waiters.values()) {
      clearTimeout(waiter.timer)
      clearInterval(waiter.progressTimer)
      waiter.reject(new Error('bridge disposed'))
    }
    this.waiters.clear()
    for (const record of this.records.values()) {
      void Promise.resolve().then(() => record.dispose?.()).catch(() => {})
    }
    this.records.clear()
  }

  #agents() {
    return this.ctx.get('agents')
  }

  /** 当前有效路由：配置 > 宿主默认模型。 */
  async #route() {
    const configured = this.routeOption?.()
    if (configured?.provider !== undefined && configured?.model !== undefined) return configured
    try {
      const selection = this.ctx.get('agentDefaultModel')?.currentSelection?.()
      if (selection?.provider !== undefined && selection?.model !== undefined) return selection
    } catch (error) {
      this.log?.warn(`读取宿主默认模型失败：${String(error)}`)
    }
    return undefined
  }

  async #presetId() {
    const presets = this.ctx.get('agentPresets')
    if (typeof presets?.resolve !== 'function') return undefined
    try {
      const resolved = await presets.resolve(undefined)
      return resolved?.id
    } catch {
      return undefined
    }
  }

  async #setup(route) {
    const presets = this.ctx.get('agentPresets')
    const presetId = await this.#presetId()
    let installModelSelection
    if (route !== undefined) {
      try {
        const mod = await import('@deepseek-ai/dsh-agent')
        installModelSelection = typeof mod.installModelSelection === 'function' ? mod.installModelSelection : undefined
      } catch {
        installModelSelection = undefined
      }
    }
    const setup = async (agentCtx) => {
      if (presetId !== undefined) await presets.mount(agentCtx, presetId)
      if (route !== undefined && installModelSelection !== undefined) {
        installModelSelection(agentCtx, { current: route, assembled: undefined })
      }
    }
    return {
      agentOptions: route === undefined ? undefined : { provider: route.provider, model: route.model },
      setup: presetId !== undefined || route !== undefined ? setup : undefined,
    }
  }

  /** DSH 的 Workspace 登记（只为 GUI 项目分组；失败不影响会话可用）。 */
  async #workspace() {
    if (this.cwd === undefined) return undefined
    if (this.workspacePromise === undefined) {
      const registry = this.ctx.get('workspaceRegistry')
      this.workspacePromise = (async () => {
        if (typeof registry?.resolveByPath !== 'function') return undefined
        try {
          const existing = await registry.resolveByPath(this.cwd)
          if (existing !== undefined) return existing
          return typeof registry.create === 'function' ? await registry.create(this.cwd) : undefined
        } catch (error) {
          this.log?.warn(`登记工作目录失败（会话仍可用）：${String(error)}`)
          return undefined
        }
      })()
    }
    return this.workspacePromise
  }

  /**
   * 取（或建）一个 peer 的 agent。
   * 顺序：内存记录 → registry 里的活 agent → resume 持久化会话 → create 新会话。
   */
  async attach(peerKey) {
    const entry = this.router.ensure(peerKey, { cwd: this.cwd })
    const sessionId = entry.sessionId
    const cached = this.records.get(sessionId)
    if (cached !== undefined && this.#isLive(sessionId, cached.agent)) return cached
    if (cached !== undefined) {
      // 记录还在但宿主侧已经 dispose：旧引用上的 followup 会被静默丢弃。
      this.records.delete(sessionId)
    }
    const inflight = this.attaching.get(sessionId)
    if (inflight !== undefined) return await inflight
    const creation = this.#attachNew(sessionId).finally(() => this.attaching.delete(sessionId))
    this.attaching.set(sessionId, creation)
    return await creation
  }

  #isLive(sessionId, agent) {
    try {
      return this.#agents()?.get?.(sessionId) === agent
    } catch {
      return false
    }
  }

  async #attachNew(sessionId) {
    const agents = this.#agents()
    if (agents === undefined) throw new Error('宿主的 agents 服务不可用（profile 没挂 dsh-agent？）')
    const route = await this.#route()
    const { agentOptions, setup } = await this.#setup(route)
    const live = agents.get?.(sessionId)
    let handle
    if (live !== undefined) {
      handle = { agent: live, dispose: async () => {} }
    } else if (typeof agents.resume === 'function') {
      try {
        handle = await agents.resume({
          resumeSessionId: sessionId,
          ...(setup === undefined ? {} : { setup }),
          ...(agentOptions === undefined ? {} : { agentOptions }),
        })
      } catch (error) {
        this.log?.info(`会话 ${sessionId} 未能 resume（${String(error).slice(0, 120)}），新建一个`)
        handle = await this.#create(agents, sessionId, setup, agentOptions)
      }
    } else {
      handle = await this.#create(agents, sessionId, setup, agentOptions)
    }
    // 归档的会话跑不动任何一步（ArchivedSessionGate 会在 25ms 内把回合打成 blocked）。
    await this.#unarchive(sessionId)
    const record = { agent: handle.agent, dispose: handle.dispose, sessionId, busy: false }
    this.records.set(sessionId, record)
    this.log?.info(`会话就绪：${sessionId}`)
    return record
  }

  async #create(agents, sessionId, setup, agentOptions) {
    if (typeof agents.create !== 'function') throw new Error('宿主的 agents 服务不支持 create')
    const workspace = await this.#workspace()
    // cwd 必须与 Workspace 的 path 逐字节一致，否则 GUI 会把它归到 Ungrouped。
    const cwd = workspace?.path ?? this.cwd
    const handle = await agents.create({
      sessionId,
      ...(agentOptions === undefined ? {} : { agentOptions }),
      ...(cwd === undefined ? {} : { meta: { cwd } }),
      ...(setup === undefined ? {} : { setup }),
      signal: AbortSignal.timeout(30_000),
    })
    if (workspace !== undefined && typeof workspace.attachSession === 'function') {
      try {
        await workspace.attachSession(sessionId)
      } catch (error) {
        this.log?.warn(`把会话登记到 Workspace 失败：${String(error)}`)
      }
    }
    return handle
  }

  async #unarchive(sessionId) {
    try {
      const registry = this.ctx.get('workspaceRegistry')
      const archived = registry?.archivedSessionIds
      if (Array.isArray(archived) && archived.includes(sessionId) && typeof registry.unarchiveSession === 'function') {
        await registry.unarchiveSession(sessionId)
        this.log?.info(`会话 ${sessionId} 处于归档状态，已取回以便继续回复`)
      }
    } catch {
      /* 尽力而为 */
    }
  }

  /** 把宿主侧标题同步到 GUI 侧栏（侧栏读的是宿主标题，不是我们路由表里的）。 */
  async #mirrorTitle(agent, title) {
    try {
      const service = this.ctx.get('sessionTitle')
      if (typeof service?.rename !== 'function') return
      await service.rename(agent.session, title)
    } catch {
      /* 标题同步失败只影响侧栏观感 */
    }
  }

  /**
   * 投递一条用户消息并等这一轮结束。
   *
   * @returns {Promise<{text: string, sessionId: string, error?: string, timedOut?: boolean}>}
   */
  async deliver({ peerKey, text, parts, title, signal, onProgress, attempt = 0 }) {
    const record = await this.attach(peerKey)
    const sessionId = record.sessionId
    const createUserMessage = await resolveCreateUserMessage()
    // 存活校验：已 dispose 的 agent 上 followup 是静默丢消息的。
    if (!this.#isLive(sessionId, record.agent)) {
      this.records.delete(sessionId)
      if (attempt >= 2) throw new Error(`会话 ${sessionId} 反复失去存活状态，请检查 DSH 日志`)
      return await this.deliver({ peerKey, text, parts, title, signal, onProgress, attempt: attempt + 1 })
    }
    const baseline = this.#lastSeq(record.agent)
    const waiter = this.#newWaiter({ sessionId, baseline, onProgress })
    this.waiters.set(sessionId, waiter)
    try {
      const headline = title ?? text
      if (headline !== undefined && String(headline).trim() !== '') {
        const stored = this.router.setTitleOnce(peerKey, headline)
        if (stored !== undefined) void this.#mirrorTitle(record.agent, stored)
      }
      // 有结构化 parts（文字 + 图片 + 文件）就用它；否则退回纯文本。
      const content = Array.isArray(parts) && parts.length > 0
        ? parts
        : [{ type: 'text', text: String(text ?? '') }]
      record.agent.followup(
        createUserMessage({ content, source: { kind: 'user' } }),
      )
      return await waiter.promise
    } finally {
      this.waiters.delete(sessionId)
      clearTimeout(waiter.timer)
      clearInterval(waiter.progressTimer)
    }
  }

  #lastSeq(agent) {
    try {
      const events = agent.session?.snapshotEvents?.() ?? []
      const last = events[events.length - 1]
      return typeof last?.seq === 'number' ? last.seq : -1
    } catch {
      return -1
    }
  }

  #newWaiter({ sessionId, baseline, onProgress }) {
    const waiter = {
      sessionId,
      baseline,
      text: '',
      settledSeq: -1,
      turnError: undefined,
      sawOurTurn: false,
      turnId: undefined,
      pendingTools: new Map(),
      startedAt: Date.now(),
      lastProgressText: '',
      resolve: undefined,
      reject: undefined,
      promise: undefined,
      timer: undefined,
      progressTimer: undefined,
    }
    waiter.promise = new Promise((resolve, reject) => {
      waiter.resolve = resolve
      waiter.reject = reject
    })
    // 超时不 reject：把已经拿到的文本交回去，用户至少看到半截答案。
    waiter.timer = setTimeout(() => {
      waiter.resolve(this.#settle(waiter, { timedOut: true }))
    }, this.maxWaitMs)
    if (typeof onProgress === 'function' && this.progressAfterMs > 0) {
      waiter.progressTimer = setInterval(() => {
        const elapsed = Date.now() - waiter.startedAt
        const note = waiter.pendingTools.size > 0
          ? `正在执行 ${[...waiter.pendingTools.values()].slice(0, 3).join('、')}（已 ${Math.round(elapsed / 1000)} 秒）`
          : `思考中（已 ${Math.round(elapsed / 1000)} 秒）`
        if (note === waiter.lastProgressText) return
        waiter.lastProgressText = note
        void Promise.resolve(onProgress(note)).catch(() => {})
      }, this.progressAfterMs)
    }
    return waiter
  }

  #settle(waiter, extra = {}) {
    clearTimeout(waiter.timer)
    clearInterval(waiter.progressTimer)
    const text = waiter.text
    const error = waiter.turnError
    return {
      text: text === '' && error === undefined && extra.timedOut === true
        ? '（这一轮还没有产生可读输出，可能仍在执行；稍后再试或发送 /stop 中断）'
        : text,
      sessionId: waiter.sessionId,
      ...(error === undefined ? {} : { error }),
      ...extra,
    }
  }

  /** durable 事件分发：只处理"有等待者"的会话。 */
  #onEvent(session, event) {
    const sessionId = session?.id
    const waiter = this.waiters.get(sessionId)
    if (waiter === undefined) return
    const seq = typeof event?.seq === 'number' ? event.seq : -1
    if (seq >= 0 && seq <= waiter.baseline) return
    switch (event?.type) {
      case 'turn/start': {
        waiter.sawOurTurn = true
        waiter.turnId = event.data?.turn?.id ?? event.data?.turnId ?? undefined
        waiter.text = ''
        waiter.settledSeq = -1
        waiter.turnError = undefined
        waiter.pendingTools.clear()
        break
      }
      case 'tool/call': {
        const callId = event.data?.callId
        if (typeof callId === 'string') waiter.pendingTools.set(callId, event.data?.name ?? 'tool')
        break
      }
      case 'tool/result': {
        const callId = event.data?.message?.source?.callId ?? event.data?.callId
        if (typeof callId === 'string') waiter.pendingTools.delete(callId)
        break
      }
      case 'turn/end': {
        if (waiter.sawOurTurn !== true) return // 别人（GUI）那一轮的收尾，不是我们的
        const turnId = event.data?.turn?.id ?? event.data?.turnId
        if (waiter.turnId !== undefined && turnId !== undefined && turnId !== waiter.turnId) return
        const reason = event.data?.reason
        if (reason?.kind === 'error') {
          const message = reason.error?.message
          waiter.turnError = typeof message === 'string' && message !== '' ? message : '未知错误'
        }
        waiter.resolve(this.#settle(waiter))
        break
      }
      default: {
        if (!SETTLED_TYPES.has(event?.type)) break
        const body = streamText(event.data?.stream) || messageText(event.data?.message)
        if (body !== '') {
          waiter.text = body
          waiter.settledSeq = seq
        }
        break
      }
    }
  }

  /** `/stop`：中断当前轮。返回一句给用户的话。 */
  cancel(peerKey) {
    const entry = this.router.get(peerKey)
    const record = entry === undefined ? undefined : this.records.get(entry.sessionId)
    if (record === undefined) return '当前没有正在执行的回合。'
    const agent = record.agent
    if (typeof agent?.cancel !== 'function') return '这个 DSH 版本不支持中断回合。'
    try {
      agent.cancel({ kind: 'user' })
      return '已请求中断当前回合。'
    } catch (error) {
      return `取消失败：${String(error)}`
    }
  }

  /** 给 /status 用的状态快照。 */
  describe(peerKey) {
    const entry = this.router.get(peerKey)
    if (entry === undefined) return '还没有会话（发一句话就会创建）。'
    const record = this.records.get(entry.sessionId)
    const busy = this.waiters.has(entry.sessionId)
    return [
      `会话：${entry.sessionId}`,
      `代次：第 ${entry.generation + 1} 个`,
      `标题：${entry.title ?? '（未命名）'}`,
      `轮次：${entry.turns ?? 0}`,
      `状态：${busy ? '正在执行' : record === undefined ? '未加载' : '空闲'}`,
    ].join('\n')
  }
}

/** 供测试使用：一个稳定的短哈希，用来断言 id 的可预测性。 */
export function shortHash(value) {
  return createHash('sha1').update(String(value)).digest('hex').slice(0, 12)
}
