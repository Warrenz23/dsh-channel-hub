/**
 * 交互卡（审批 / 提问）的应答方。
 *
 * DSH 的设计很干净，但把"补齐"留给了应答方：
 *  - 渲染卡片 = 在 `approval/request` 这个 agent-scoped waterfall 上注册监听器；
 *  - 裁决 = 从监听器 **return** 一个 outcome（`allowed-once` / `rejected` /
 *    `cancelled` / `unavailable`），或者调 `next()` 把决定权交回后面的监听器；
 *  - 答案方**拿不到审批 id**（id 是请求方内部随机的），所以卡片 id 得自己造；
 *  - 没有超时、没有"已被其他端处理"的回执 —— 这两件事必须自己做。
 *
 * 还有一个坑：`prepend: true` 是硬要求。不加的话 GUI 的应答者排在前面，
 * 它不调 next() 就永远轮不到 IM 这边，而且**不会有任何报错**。
 *
 * 这里的策略是"竞速 + 撤卡"：同时挂 `next()`（GUI）和 IM 等待，谁先答谁生效；
 * IM 赢的时候把 GUI 卡片的 signal fork 掉，让网页上的卡自动收起，但**不动
 * 原 signal**（动了就会把整轮 turn 杀掉）。
 */
import { randomUUID } from 'node:crypto'

const DEFAULT_TIMEOUT_MS = 30 * 60_000

/** 解析聊天里的措辞：允许 1/2、允许/拒绝、/approve、/deny。 */
export function parseDecision(text) {
  const value = String(text ?? '').trim().toLowerCase()
  if (value === '') return undefined
  if (['1', 'allow', 'approve', 'yes', 'y', '允许', '同意', '批准', '/approve', '/allow'].includes(value)) return 'allowed-once'
  if (['2', 'deny', 'reject', 'no', 'n', '拒绝', '不允许', '/deny', '/reject'].includes(value)) return 'rejected'
  if (['/cancel', '/stop', '取消'].includes(value)) return 'cancelled'
  return undefined
}

/** 解析提问卡的编号回复：`1`、`1,3`、`1 3`。 */
export function parseChoices(text, optionCount) {
  const raw = String(text ?? '').trim()
  if (raw === '') return undefined
  const parts = raw.split(/[,，\s]+/).filter((part) => part !== '')
  const picked = []
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return undefined
    const index = Number(part) - 1
    if (!Number.isInteger(index) || index < 0 || index >= optionCount) return undefined
    if (!picked.includes(index)) picked.push(index)
  }
  return picked
}

export class CardGate {
  /**
   * @param {object} options
   * @param {any} options.ctx
   * @param {any} options.router
   * @param {any} options.log
   * @param {{sendCard: Function, sendText: Function}} options.notifier
   * @param {number} [options.timeoutMs] 软超时：只摘卡 + 提示，不替用户决定
   * @param {boolean} [options.dismissGuiCard]
   */
  constructor({ ctx, router, log, notifier, timeoutMs = DEFAULT_TIMEOUT_MS, dismissGuiCard = true }) {
    this.ctx = ctx
    this.router = router
    this.log = log
    this.notifier = notifier
    this.timeoutMs = timeoutMs
    this.dismissGuiCard = dismissGuiCard
    /** @type {Map<string, any>} 自定义卡片 id -> 待办 */
    this.pending = new Map()
    this.installed = false
  }

  install() {
    if (this.installed) return
    this.installed = true
    this.offApproval = this.ctx.on('approval/request', (req, next) => this.#onApproval(req, next), { prepend: true })
    this.offQuestion = this.ctx.on('user-questions/request', (req, next) => this.#onQuestion(req, next), { prepend: true })
    this.log?.info('已挂上 approval/request 与 user-questions/request 监听器')
  }

  dispose() {
    this.installed = false
    this.offApproval?.()
    this.offQuestion?.()
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.settle(entry.kind === 'approval' ? 'cancelled' : undefined, true)
      entry.cleanup?.()
    }
    this.pending.clear()
  }

  /** 这个会话归属哪个聊天窗口（不是我们的会话就返回 undefined，交回 GUI）。 */
  #peerOf(agent) {
    const sessionId = agent?.session?.id
    if (sessionId === undefined) return undefined
    const peerKey = this.router.peerForSession(sessionId)
    return peerKey === undefined ? undefined : { peerKey, sessionId }
  }

  /** 当前 peer 的待办，按创建顺序。 */
  pendingFor(peerKey) {
    return [...this.pending.values()].filter((entry) => entry.peerKey === peerKey)
  }

  /** 所有待办（控制台展示用，不含内部 settle 句柄）。 */
  list() {
    return [...this.pending.values()].map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      peerKey: entry.peerKey,
      toolName: entry.toolName,
      question: entry.question,
    }))
  }

  #register(entry) {
    this.pending.set(entry.id, entry)
    entry.timer = setTimeout(() => {
      if (!this.pending.has(entry.id)) return
      // 软超时：卡片摘掉、提示一句，但**不裁决** —— GUI 那边还可以继续答。
      this.pending.delete(entry.id)
      void this.notifier.sendText(entry.peerKey, `⌛ 卡片 ${entry.id} 等待超时，已从聊天里撤下（网页端仍可处理）。`).catch(() => {})
      entry.cleanup?.()
    }, this.timeoutMs)
  }

  #unregister(id) {
    const entry = this.pending.get(id)
    if (entry === undefined) return undefined
    clearTimeout(entry.timer)
    this.pending.delete(id)
    entry.cleanup?.()
    return entry
  }

  /**
   * 把 GUI 卡片的展示寿命从 turn 的 signal 上解耦。
   *
   * 原理：waterfall 传的是同一个 req 对象，就地替换 req.signal 会让排在后面的
   * GUI 应答者拿到 fork 版本；我们 abort fork 只会撤卡，原 turn 不受影响。
   * 这依赖"req 在 waterfall 内共享可变"这一未文档化细节，所以整体 try/catch，
   * 关掉 dismissGuiCard 就完全不碰它。
   */
  #forkGuiSignal(req) {
    if (this.dismissGuiCard !== true) return undefined
    try {
      const original = req.signal
      if (original === undefined || original === null) return undefined
      const controller = new AbortController()
      const forward = () => {
        try { controller.abort(original.reason) } catch { /* 已中止 */ }
      }
      if (original.aborted) forward()
      else original.addEventListener('abort', forward, { once: true })
      req.signal = controller.signal
      return {
        abortGui: () => { try { controller.abort('answered-on-im') } catch { /* 已中止 */ } },
        dispose: () => { try { original.removeEventListener('abort', forward) } catch { /* 忽略 */ } },
      }
    } catch {
      return undefined
    }
  }

  async #onApproval(req, next) {
    const owned = this.#peerOf(req.agent)
    if (owned === undefined) return await next()
    const id = `A${randomUUID().slice(0, 6)}`
    const toolName = req.toolName ?? req.data?.toolName
    const reason = req.displayReason ?? req.reason ?? ''
    const forked = this.#forkGuiSignal(req)
    let settled = false
    /** @type {(outcome: string, silent?: boolean) => void} */
    let settle
    const imAnswer = new Promise((resolve) => {
      settle = (outcome) => {
        if (settled) return
        settled = true
        resolve(outcome)
      }
    })
    const entry = {
      id,
      kind: 'approval',
      peerKey: owned.peerKey,
      sessionId: owned.sessionId,
      toolName,
      settle: (outcome, silent) => {
        settle(outcome)
        if (silent !== true) void this.notifier.sendText(owned.peerKey, outcome === 'allowed-once' ? '✅ 已允许这一次调用。' : '⛔ 已拒绝这次调用。').catch(() => {})
      },
      cleanup: () => forked?.dispose(),
    }
    this.#register(entry)
    void this.notifier.sendApprovalCard(owned.peerKey, {
      id, toolName, reason, sessionLabel: this.router.get(owned.peerKey)?.title,
    }).catch((error) => this.log?.warn(`审批卡发送失败：${String(error)}`))

    // GUI 一侧（含其他 answerer）也要挂上，才能"谁先答谁生效"。
    // 注意：宿主在**没有**交互终端时会立刻返回 'unavailable'。那不是"GUI 答了"，
    // 而是"没人会答"，此时必须继续等 IM，否则卡片发出去会立刻被判成不可用。
    const gui = next().then(
      (outcome) => ({ from: 'gui', outcome }),
      () => ({ from: 'gui', outcome: 'unavailable' }),
    )
    const guiDecision = gui.then((result) => (
      result.outcome === 'unavailable' ? new Promise(() => {}) : result
    ))
    const onAbort = () => settle('cancelled')
    req.signal?.addEventListener?.('abort', onAbort, { once: true })
    try {
      const winner = await Promise.race([guiDecision, imAnswer.then((outcome) => ({ from: 'im', outcome }))])
      if (winner.from === 'im') {
        forked?.abortGui?.()
      } else if (this.pending.has(id)) {
        this.#unregister(id)
        void this.notifier.sendText(owned.peerKey, `ℹ️ 审批 ${id} 已在其他端处理。`).catch(() => {})
      }
      return winner.outcome
    } finally {
      req.signal?.removeEventListener?.('abort', onAbort)
      this.#unregister(id)
    }
  }

  async #onQuestion(req, next) {
    const owned = this.#peerOf(req.agent)
    if (owned === undefined) return await next()
    const questions = Array.isArray(req.questions) ? req.questions : []
    if (questions.length === 0) return await next()
    const id = `Q${randomUUID().slice(0, 6)}`
    const forked = this.#forkGuiSignal(req)
    let settled = false
    let answer
    const imAnswer = new Promise((resolve, reject) => {
      answer = (value) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      // 卡片超时不是错误：等 GUI 或 turn 自己结束。
      void reject
    })
    // 一次只展示第一题（多题场景在实际使用里极少，先保证单题体验正确）。
    const first = questions[0]
    const options = (first.options ?? []).map((option) => ({
      label: option.label ?? String(option),
      value: option.label ?? String(option),
    }))
    const entry = {
      id,
      kind: 'question',
      peerKey: owned.peerKey,
      sessionId: owned.sessionId,
      question: first.question,
      options,
      multiSelect: first.multiSelect === true,
      questionId: first.id,
      settle: (value) => answer(value),
    }
    this.#register(entry)
    void this.notifier.sendQuestionCard(owned.peerKey, {
      id, question: first.question, header: first.header, options, multiSelect: entry.multiSelect,
    }).catch((error) => this.log?.warn(`提问卡发送失败：${String(error)}`))

    const gui = next().then(
      (result) => ({ from: 'gui', result }),
      () => ({ from: 'gui', result: undefined }),
    )
    const guiDecision = gui.then((result) => (
      result.result === undefined || result.result === null ? new Promise(() => {}) : result
    ))
    try {
      const winner = await Promise.race([guiDecision, imAnswer.then((result) => ({ from: 'im', result }))])
      if (winner.from === 'im') {
        forked?.abortGui?.()
        return winner.result
      }
      if (this.pending.has(id)) {
        this.#unregister(id)
        void this.notifier.sendText(owned.peerKey, `ℹ️ 提问 ${id} 已在其他端回答。`).catch(() => {})
      }
      return winner.result
    } finally {
      this.#unregister(id)
    }
  }

  /**
   * 聊天文本 → 卡片裁决。
   *
   * @returns {Promise<{handled: boolean, reply?: string}>}
   */
  async answerFromText(peerKey, text) {
    const pending = this.pendingFor(peerKey)
    if (pending.length === 0) return { handled: false }
    const raw = String(text ?? '').trim()
    // 显式点名：`/approve A1ab12c`、`A1ab12c 1`
    const explicit = /^\/?(approve|deny)\s+([AQ][0-9a-f]{6})$/i.exec(raw) ?? /^([AQ][0-9a-f]{6})\s+([12])$/i.exec(raw)
    if (explicit !== null) {
      const isFirstForm = /^\/?approve|deny/i.test(explicit[1])
      const id = isFirstForm ? explicit[2] : explicit[1]
      const outcome = isFirstForm
        ? (explicit[1].toLowerCase() === 'approve' ? 'allowed-once' : 'rejected')
        : parseDecision(explicit[2])
      const entry = this.#unregister(id)
      if (entry === undefined) return { handled: true, reply: `没有待处理的卡片 ${id}。` }
      entry.settle(outcome, true)
      return { handled: true, reply: outcome === 'allowed-once' ? `✅ ${id} 已允许。` : `⛔ ${id} 已拒绝。` }
    }
    if (pending.length > 1) {
      const list = pending.map((entry) => `· ${entry.id}（${entry.kind === 'approval' ? `审批 ${entry.toolName ?? ''}` : '提问'}）`).join('\n')
      return {
        handled: true,
        reply: `现在有 ${pending.length} 张待处理卡片，请点名：/approve <ID> 或 /deny <ID>\n${list}`,
      }
    }
    const entry = pending[0]
    if (entry.kind === 'approval') {
      const outcome = parseDecision(raw)
      if (outcome === undefined) {
        return { handled: true, reply: `这条消息是给审批卡片 ${entry.id} 的：回复 1 允许、2 拒绝，或 /approve · /deny。` }
      }
      this.#unregister(entry.id)
      entry.settle(outcome, true)
      return { handled: true, reply: outcome === 'allowed-once' ? '✅ 已允许这一次调用。' : outcome === 'rejected' ? '⛔ 已拒绝。' : '已取消这次审批。' }
    }
    // 提问卡
    const selected = entry.options.length === 0
      ? [raw]
      : parseChoices(raw, entry.options.length)?.map((index) => entry.options[index].value)
    if (selected === undefined || selected.length === 0) {
      return { handled: true, reply: `回复 1-${entry.options.length} 之间的编号来选择。` }
    }
    this.#unregister(entry.id)
    entry.settle({ answers: [{ id: entry.questionId, selected, ...(entry.options.length === 0 ? { custom: raw } : {}) }] })
    return { handled: true, reply: `已提交：${selected.join('、')}` }
  }

  /**
   * 卡片按钮回调（飞书 card.action.trigger 走这里）。
   *
   * @returns {Promise<{toast: string}>}
   */
  async answerFromAction({ peerKey, value }) {
    const id = typeof value?.id === 'string' ? value.id : undefined
    if (id === undefined) return { toast: '无法识别的操作' }
    const entry = this.pending.get(id)
    if (entry === undefined) return { toast: '这张卡已经处理过了' }
    if (entry.peerKey !== peerKey) return { toast: '这张卡不属于这个会话' }
    if (value.hub === 'approve') {
      this.#unregister(id)
      entry.settle('allowed-once', true)
      return { toast: '已允许这一次调用' }
    }
    if (value.hub === 'deny') {
      this.#unregister(id)
      entry.settle('rejected', true)
      return { toast: '已拒绝' }
    }
    if (value.hub === 'answer') {
      this.#unregister(id)
      const selected = [String(value.choice)]
      entry.settle({ answers: [{ id: entry.questionId, selected }] })
      return { toast: '已提交' }
    }
    return { toast: '无法识别的操作' }
  }
}
