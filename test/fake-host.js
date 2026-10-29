/**
 * 假宿主：在测试里复现 DSH 那几个真正被用到的接口。
 *
 * 这不是"造一个假框架"，而是把契约钉在测试里：`ctx.on('session/event')`、
 * `approval/request` 的 waterfall、`agents.create/resume/get`、`agent.followup`
 * 的语义。真宿主的形状变了，这里的测试会先红。
 */
import { randomUUID } from 'node:crypto'

/** 一个按序递增的 session 事件源。 */
export function createFakeSession(id) {
  const events = []
  return {
    id,
    events,
    snapshotEvents() {
      return events
    },
    append(type, data) {
      const event = { seq: events.length, type, ...(data === undefined ? {} : { data }) }
      events.push(event)
      return event
    },
  }
}

export function createFakeHost({ reply, onTurn, failWith, latencyMs = 0 } = {}) {
  /** @type {Map<string, Array<{fn: Function, prepend: boolean}>>} */
  const listeners = new Map()
  const agents = new Map()
  const created = []
  const sessions = new Map()
  const services = new Map()
  /** 每条投给 agent 的用户消息（测试用来断言 content 里有什么）。 */
  const messages = []

  function on(event, fn, options) {
    const list = listeners.get(event) ?? []
    if (options?.prepend === true) list.unshift({ fn, prepend: true })
    else list.push({ fn, prepend: false })
    listeners.set(event, list)
    return () => {
      const current = listeners.get(event) ?? []
      const index = current.findIndex((item) => item.fn === fn)
      if (index >= 0) current.splice(index, 1)
    }
  }

  function emit(event, ...args) {
    for (const { fn } of [...(listeners.get(event) ?? [])]) fn(...args)
  }

  /** waterfall：按注册顺序串起来，最后一个 next() 返回 fallback。 */
  async function waterfall(event, request, fallback) {
    const list = [...(listeners.get(event) ?? [])]
    const call = (index) => {
      const item = list[index]
      if (item === undefined) return Promise.resolve(fallback)
      return Promise.resolve(item.fn(request, () => call(index + 1)))
    }
    return await call(0)
  }

  function makeAgent(sessionId) {
    const session = createFakeSession(sessionId)
    sessions.set(sessionId, session)
    let cancelled = false
    const agent = {
      session,
      followup(message) {
        cancelled = false
        setTimeout(() => { void runTurn(agent, message) }, latencyMs)
      },
      steer() {},
      inject() {},
      cancel() { cancelled = true },
      async whenIdle() {},
      status: 'idle',
    }
    agents.set(sessionId, agent)
    return agent
  }

  async function runTurn(agent, message) {
    messages.push(message)
    const text = Array.isArray(message?.content)
      ? message.content.map((block) => block.text ?? '').join('')
      : String(message?.text ?? '')
    const session = agent.session
    const push = (type, data) => {
      const event = session.append(type, data)
      emit('session/event', session, event)
      return event
    }
    push('turn/start', { turn: { id: `t${session.events.length}` } })
    if (typeof onTurn === 'function') {
      const scripted = await onTurn({ text, session, push })
      if (scripted === 'skip') {
        push('turn/end', { reason: { kind: 'completed' } })
        return
      }
    }
    if (failWith !== undefined) {
      push('turn/end', { reason: { kind: 'error', error: { message: failWith } } })
      return
    }
    const answer = typeof reply === 'function' ? await reply(text) : (reply ?? `echo: ${text}`)
    push('assistant/message', { stream: [{ type: 'text-chunks', texts: [answer] }] })
    push('turn/end', { reason: { kind: 'completed' } })
  }

  const agentsService = {
    create(options) {
      const agent = makeAgent(options.sessionId)
      created.push(options)
      return Promise.resolve({ agent, dispose: async () => { agents.delete(options.sessionId) } })
    },
    resume(options) {
      const existing = sessions.get(options.resumeSessionId)
      if (existing === undefined) return Promise.reject(new Error('session not found'))
      const agent = makeAgent(options.resumeSessionId)
      return Promise.resolve({ agent, dispose: async () => { agents.delete(options.resumeSessionId) } })
    },
    get(id) {
      return agents.get(id)
    },
    list() {
      return [...agents.values()]
    },
    roots() {
      return [...agents.values()]
    },
  }

  services.set('agents', agentsService)
  services.set('agentDefaultModel', { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) })
  services.set('agentPresets', { resolve: async () => ({ id: 'default' }), mount: async () => {} })
  services.set('workspaceRegistry', {
    archivedSessionIds: [],
    resolveByPath: async (path) => ({ path, attachSession: async () => {}, sessionIds: [] }),
    create: async (path) => ({ path, attachSession: async () => {}, sessionIds: [] }),
  })
  services.set('sessionTitle', { rename: async () => {} })
  // 附件服务：把 image 部分换成 durable ref，file 部分原样透传（和真宿主同形）。
  services.set('attachments', {
    async admitPromptContent(content) {
      return content.map((part, index) => {
        if (part.type === 'text') return { type: 'text', text: part.text }
        if (part.type === 'file') return { type: 'file', attachment: part.attachment }
        return { type: 'image', attachment: { id: `att-${index}`, mediaType: part.mediaType } }
      })
    },
    async saveFile({ data, name }) {
      return { id: `file-${name ?? 'unnamed'}`, size: data?.byteLength ?? 0 }
    },
  })

  const ctx = {
    on,
    emit,
    waterfall,
    get: (name) => services.get(name),
    inject: (_deps, callback) => callback(ctx),
    effect: (factory) => {
      const disposer = factory()
      return () => disposer?.()
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  }

  return {
    ctx,
    agents: agentsService,
    sessions,
    created,
    messages,
    emit,
    waterfall,
    services,
    /** 触发一次审批请求，走真实的 waterfall 链路。 */
    requestApproval({ agent, toolName = 'bash', reason = '需要写文件', signal = new AbortController().signal }) {
      return waterfall('approval/request', { agent, toolName, reason, signal }, 'unavailable')
    },
    /** 触发一次提问请求。 */
    requestQuestion({ agent, questions, signal = new AbortController().signal }) {
      return waterfall('user-questions/request', { agent, questions, signal }, undefined)
    },
    /** 造一个已存在的会话（resume 场景）。 */
    seedSession(sessionId) {
      createFakeSession(sessionId)
      sessions.set(sessionId, sessions.get(sessionId) ?? createFakeSession(sessionId))
    },
    newAgentId() {
      return `s-${randomUUID().slice(0, 8)}`
    },
  }
}
