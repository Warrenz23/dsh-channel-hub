/**
 * 文件日志：插件自己的排障出口。
 *
 * 为什么不用 ctx.logger 就够了：宿主日志的导出级别取决于 profile 配置，
 * 而"通道插件不回复"这类问题九成要看**插件这一侧**到底收没收到消息。
 * 所以每一行都同时写进 <stateDir>/logs/hub-YYYY-MM-DD.log，前缀统一，
 * 用户可以直接 grep。
 */
import { createWriteStream, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const PREFIX = 'dsh-channel-hub:'

/** 单行格式化：时间 + 级别 + 作用域 + 正文。 */
function formatLine(level, scope, message) {
  const stamp = new Date().toISOString()
  const text = String(message ?? '')
  // 多行内容保持可读，但每条日志只占一个"记录块"。
  const body = text.includes('\n') ? text.replace(/\n/g, '\n    ') : text
  return `${stamp} ${level.toUpperCase().padEnd(5)} ${scope ? `[${scope}] ` : ''}${body}\n`
}

/**
 * @param {object} options
 * @param {string} options.dir         日志目录（<stateDir>/logs）
 * @param {(line: string) => void} [options.hostLog]  宿主的 info 出口
 * @param {(line: string) => void} [options.hostErr]  宿主的 warn/error 出口
 * @param {string} [options.scope]     默认作用域
 */
export function createLogger({ dir, hostLog, hostErr, scope = '' } = {}) {
  let stream
  let day = ''
  let closed = false

  function ensureStream() {
    if (closed) return undefined
    const today = new Date().toISOString().slice(0, 10)
    if (stream !== undefined && day === today) return stream
    try {
      mkdirSync(dir, { recursive: true })
      stream?.end()
      stream = createWriteStream(join(dir, `hub-${today}.log`), { flags: 'a' })
      stream.on('error', () => { stream = undefined })
      day = today
    } catch {
      stream = undefined
    }
    return stream
  }

  function write(level, message, at = scope) {
    const line = formatLine(level, at, message)
    try {
      ensureStream()?.write(line)
    } catch {
      /* 磁盘满 / 目录没了都不该让通道停摆 */
    }
    // 宿主日志是第二出口：宿主日志丢了还有文件，反之亦然。
    try {
      if (level === 'error' || level === 'warn') (hostErr ?? hostLog)?.(line.trimEnd())
      else hostLog?.(line.trimEnd())
    } catch {
      /* 宿主 logger 抛错不影响主流程 */
    }
  }

  const logger = {
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    error: (message) => write('error', message),
    /** 派生一个带固定作用域的 logger，用于按会话/账号区分。 */
    child(childScope) {
      const prefix = scope ? `${scope}/${childScope}` : childScope
      return {
        info: (m) => write('info', m, prefix),
        warn: (m) => write('warn', m, prefix),
        error: (m) => write('error', m, prefix),
        child: (deeper) => logger.child(`${childScope}/${deeper}`),
      }
    },
    close() {
      closed = true
      try { stream?.end() } catch { /* 已关闭 */ }
      stream = undefined
    },
  }
  return logger
}

export { PREFIX }
