/**
 * 原始事件嗅探：用同一份凭证单独连一条长连接，把收到的每一帧都打出来。
 *
 * 目的：区分三种情况
 *   1. 一帧都没有        → 飞书根本没往这个 app 推事件（订阅/发布/加密配置问题）
 *   2. 有帧但 "no XXX handle" → 事件类型和我们注册的不一致
 *   3. 有帧但解密报错     → 应用开了「加密策略」，需要 Encrypt Key
 *
 * 用法：node _ref/sniff.mjs [秒数]
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const seconds = Number(process.argv[2] ?? 300)
const stateDir = process.env.DSH_HUB_STATE_DIR
  ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'channel-hub')
const cfg = JSON.parse(readFileSync(join(stateDir, 'config.json'), 'utf8')).adapters.feishu
const sdk = await import('@larksuiteoapi/node-sdk')

const stamp = () => new Date().toISOString().slice(11, 23)
const say = (tag, ...rest) => console.log(`${stamp()} ${tag}`, ...rest.map((v) => typeof v === 'string' ? v : safe(v)))

function safe(value) {
  try {
    const text = JSON.stringify(value)
    return text.length > 600 ? `${text.slice(0, 600)}…` : text
  } catch {
    return String(value)
  }
}

let frames = 0
const unknownTypes = new Set()

const logger = {
  debug: (...args) => say('[sdk:debug]', ...args),
  info: (...args) => say('[sdk:info ]', ...args),
  warn: (...args) => {
    const text = args.map(String).join(' ')
    const match = /no (\S+) handle/.exec(text)
    if (match) unknownTypes.add(match[1])
    say('[sdk:warn ]', ...args)
  },
  error: (...args) => say('[sdk:error]', ...args),
  trace: (...args) => say('[sdk:trace]', ...args),
}

const dispatcher = new sdk.EventDispatcher({ loggerLevel: sdk.LoggerLevel.debug, logger })
dispatcher.register({
  'im.message.receive_v1': async (data) => {
    frames += 1
    say('[EVENT im.message.receive_v1]', safe(data))
    return { code: 0 }
  },
  'card.action.trigger': async (data) => {
    frames += 1
    say('[EVENT card.action.trigger]', safe(data))
    return { toast: { type: 'info', content: 'ok' } }
  },
})

const client = new sdk.WSClient({
  appId: cfg.appId,
  appSecret: cfg.appSecret,
  loggerLevel: sdk.LoggerLevel.debug,
  logger,
  autoReconnect: true,
  onReady: () => say('[ready] 长连接就绪'),
  onError: (error) => say('[error]', String(error?.message ?? error)),
  onReconnecting: () => say('[reconnecting]'),
  onReconnected: () => say('[reconnected]'),
})

say('[start] 嗅探开始，等待', seconds, '秒；期间请在飞书里发消息')
void client.start({ eventDispatcher: dispatcher }).catch((error) => say('[fatal]', String(error?.message ?? error)))

await new Promise((resolve) => setTimeout(resolve, seconds * 1000))

say('[summary] 收到事件数 =', frames)
say('[summary] 出现过的未知事件类型 =', unknownTypes.size === 0 ? '（无）' : [...unknownTypes].join(', '))
say('[summary] 连接状态 =', safe(client.getConnectionStatus?.() ?? {}))
try { client.close({ force: true }) } catch { /* 已关闭 */ }
process.exit(0)
