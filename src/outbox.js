/**
 * 出站兜底队列。
 *
 * 为什么要它：agent 已经跑完、回复已经生成，这时候网络抖一下或者飞书的
 * 频控回一个 429，用户就永远看不到答案了 —— 而且他完全不知道为什么。
 * DSH 没有投递重试，所以这一段必须自己兜。
 *
 * 策略：直接发；失败进磁盘队列（指数退避，最多 6 次）。队列有上界，
 * 超过就丢最老的并记一条 warn —— 宁可丢旧消息，也不要把进程拖垮。
 */
import { randomUUID } from 'node:crypto'
import { readJson, tryWriteJson } from './store.js'

const MAX_ATTEMPTS = 6
const MAX_ITEMS = 100

export function createOutbox({ file, send, log, baseDelayMs = 2_000, maxDelayMs = 5 * 60_000 }) {
  const state = readJson(file, { version: 1, items: [] })
  const items = Array.isArray(state?.items) ? state.items : []
  let timer
  let closed = false
  let flushing = false

  const persist = () => tryWriteJson(file, { version: 1, items }, (error) => log?.warn(`出站队列写入失败：${String(error)}`))

  const schedule = () => {
    if (closed || timer !== undefined || items.length === 0) return
    const next = Math.min(...items.map((item) => item.nextAt ?? 0))
    const delay = Math.max(0, next - Date.now())
    timer = setTimeout(() => {
      timer = undefined
      void flush()
    }, delay)
    timer.unref?.()
  }

  async function flush() {
    if (closed || flushing) return
    flushing = true
    try {
      const now = Date.now()
      for (const item of [...items]) {
        if ((item.nextAt ?? 0) > now) continue
        try {
          await send(item)
          const index = items.indexOf(item)
          if (index >= 0) items.splice(index, 1)
          persist()
        } catch (error) {
          item.attempts = (item.attempts ?? 0) + 1
          item.lastError = String(error).slice(0, 200)
          if (item.attempts >= MAX_ATTEMPTS) {
            const index = items.indexOf(item)
            if (index >= 0) items.splice(index, 1)
            log?.warn(`出站消息最终失败（${item.peerKey}）：${item.lastError}`)
          } else {
            const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (item.attempts - 1))
            item.nextAt = Date.now() + delay
          }
          persist()
        }
      }
    } finally {
      flushing = false
      schedule()
    }
  }

  return {
    /** 发送；失败自动入队。返回是否直接送达。 */
    async deliver(item) {
      const record = { id: randomUUID(), attempts: 0, nextAt: 0, ...item }
      try {
        await send(record)
        return true
      } catch (error) {
        log?.warn(`出站发送失败，已入队重试：${String(error)}`)
        record.lastError = String(error).slice(0, 200)
        record.attempts = 1
        record.nextAt = Date.now() + baseDelayMs
        items.push(record)
        while (items.length > MAX_ITEMS) items.shift()
        persist()
        schedule()
        return false
      }
    },
    flush,
    size: () => items.length,
    close() {
      closed = true
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    },
  }
}
