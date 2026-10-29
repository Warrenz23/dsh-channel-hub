/**
 * 会话路由表：一个聊天窗口 ↔ 一个 DSH 会话。
 *
 * 核心决定：**sessionId 由 peer 确定性派生**，不是随机的。
 *  - 插件重启、DSH 重启、甚至换一台机器迁移状态文件之后，同一个人发消息
 *    仍然落到同一个会话（`agents.resume` 能接上历史）。
 *  - `/new` 不是删会话，而是把"代次"加一：旧会话在 GUI 里还在，只是不再被
 *    这个聊天窗口使用。这点比"直接删"安全得多 —— 用户误触不会丢历史。
 *
 * 状态文件里只有映射，没有消息内容；消息原文进 journal（可关）。
 */
import { createHash } from 'node:crypto'
import { readJson, tryWriteJson } from './store.js'

const SCHEMA_VERSION = 1

/** peerKey -> 稳定、可做文件名的会话 id。 */
export function sessionIdFor(peerKey, generation = 0) {
  const digest = createHash('sha1').update(String(peerKey)).digest('hex').slice(0, 12)
  return `hub-${digest}-g${generation}`
}

/** `feishu:oc_123` → `feishu`。 */
export function platformOf(peerKey) {
  return String(peerKey).split(':', 1)[0]
}

export class SessionRouter {
  /**
   * @param {object} options
   * @param {string} options.file   状态文件路径
   * @param {{warn: (m: string) => void}} [options.log]
   */
  constructor({ file, log } = {}) {
    this.file = file
    this.log = log
    const loaded = readJson(file, undefined)
    if (loaded !== undefined && loaded?.version !== SCHEMA_VERSION) {
      this.log?.warn(`路由表版本不符（${String(loaded?.version)}），按空表启动；旧文件保留在 ${file}`)
    }
    this.state = loaded?.version === SCHEMA_VERSION && typeof loaded.peers === 'object' && loaded.peers !== null
      ? loaded
      : { version: SCHEMA_VERSION, peers: {} }
  }

  #persist() {
    tryWriteJson(this.file, this.state, (error) => this.log?.warn(`路由表写入失败：${String(error)}`))
  }

  /** 取（必要时创建）一个 peer 的活动会话。 */
  ensure(peerKey, { cwd } = {}) {
    const existing = this.state.peers[peerKey]
    if (existing !== undefined) {
      if (cwd !== undefined) existing.cwd = cwd
      existing.lastSeenAt = new Date().toISOString()
      this.#persist()
      return existing
    }
    const now = new Date().toISOString()
    const entry = {
      generation: 0,
      sessionId: sessionIdFor(peerKey, 0),
      title: undefined,
      createdAt: now,
      lastSeenAt: now,
      cwd,
      turns: 0,
    }
    this.state.peers[peerKey] = entry
    this.#persist()
    return entry
  }

  /** `/new`：代次 +1，换一个新会话；旧会话留在 DSH 里。 */
  rotate(peerKey, { cwd } = {}) {
    const current = this.ensure(peerKey, { cwd })
    const generation = (current.generation ?? 0) + 1
    const now = new Date().toISOString()
    const entry = {
      generation,
      sessionId: sessionIdFor(peerKey, generation),
      title: undefined,
      createdAt: now,
      lastSeenAt: now,
      cwd: cwd ?? current.cwd,
      turns: 0,
    }
    this.state.peers[peerKey] = entry
    this.#persist()
    return entry
  }

  /** 第一句话成为标题；已经有标题就不再改（否则 /list 全是最后一句话）。 */
  setTitleOnce(peerKey, text) {
    const entry = this.state.peers[peerKey]
    if (entry === undefined || entry.title !== undefined) return entry?.title
    const title = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)
    if (title === '') return undefined
    entry.title = title
    this.#persist()
    return title
  }

  /** 记一次完成的对话轮次（/status 用）。 */
  noteTurn(peerKey) {
    const entry = this.state.peers[peerKey]
    if (entry === undefined) return
    entry.turns = (entry.turns ?? 0) + 1
    entry.lastSeenAt = new Date().toISOString()
    this.#persist()
  }

  get(peerKey) {
    return this.state.peers[peerKey]
  }

  /** 反查：宿主会话 id → peerKey（审批卡要靠它找回聊天窗口）。 */
  peerForSession(sessionId) {
    for (const [peerKey, entry] of Object.entries(this.state.peers)) {
      if (entry.sessionId === sessionId) return peerKey
    }
    return undefined
  }

  list() {
    return Object.entries(this.state.peers).map(([peerKey, entry]) => ({ peerKey, ...entry }))
  }

  /** 兜底扫描：DSH 侧已归档的会话不该再被路由。 */
  forget(peerKey) {
    delete this.state.peers[peerKey]
    this.#persist()
  }
}
