/**
 * 落盘小工具：所有状态写操作都走这里。
 *
 * 三条规则（踩过坑才写下的）：
 *  1. 写 JSON 必须 temp + fsync + rename —— 进程被宿主杀掉是常态，
 *     半截文件会让下一次启动直接读不出会话映射，用户以为"机器人失忆"。
 *  2. 读失败只 warn + 回退默认值，绝不抛错打断插件加载。
 *  3. 去重集合有上界 —— 通道消息 id 是无限增长的，内存里不能常驻。
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

/** 读取 JSON，缺失或损坏时返回 fallback。 */
export function readJson(path, fallback) {
  try {
    const text = readFileSync(path, 'utf8')
    const value = JSON.parse(text)
    return value ?? fallback
  } catch {
    return fallback
  }
}

/** 原子写 JSON（temp + fsync + rename）。失败抛错，由调用方决定是否吞掉。 */
export function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  const body = JSON.stringify(value, null, 2)
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, body)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
}

/** 尽力而为的原子写：失败只回调，不打断消息处理。 */
export function tryWriteJson(path, value, onError) {
  try {
    writeJsonAtomic(path, value)
    return true
  } catch (error) {
    onError?.(error)
    return false
  }
}

/** 追加一行 JSONL。 */
export function appendJsonl(path, record, onError) {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const fd = openSync(path, 'a')
    try {
      writeSync(fd, `${JSON.stringify(record)}\n`)
    } finally {
      closeSync(fd)
    }
    return true
  } catch (error) {
    onError?.(error)
    return false
  }
}

/**
 * 有界去重集合。
 *
 * 平台会重投事件（飞书 3 秒未 ack 就重试、企业微信同理），没有去重用户就会
 * 看到同一条回复两次。这里用 Set + 数组做 FIFO 淘汰，容量默认 512 条，
 * 足够覆盖任何平台的窗口期。
 */
export class SeenSet {
  constructor(capacity = 512) {
    this.capacity = capacity
    this.order = []
    this.seen = new Set()
  }

  has(id) {
    return this.seen.has(id)
  }

  add(id) {
    if (this.seen.has(id)) return false
    this.seen.add(id)
    this.order.push(id)
    while (this.order.length > this.capacity) {
      this.seen.delete(this.order.shift())
    }
    return true
  }

  get size() {
    return this.seen.size
  }
}
