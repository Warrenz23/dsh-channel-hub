/**
 * 配置解析：patch 里的 config + 状态目录里的 config.json + 环境变量。
 *
 * 为什么要三层：`cordis.patch.yml` 是会被提交/分享的文件，不能放 app secret；
 * 而让用户每次改配置都去编辑 YAML 也不现实。所以优先级是
 *   **环境变量 > <stateDir>/config.json > patch config**
 * secret 建议只放 config.json（daemon 会把它设成 0600）或环境变量。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { readJson, writeJsonAtomic } from './store.js'

export const DEFAULTS = {
  // 本地控制台：默认开。它就是"填凭证/连飞书/放行自己"的图形入口。
  admin: {
    enabled: true,
    port: 17867,
    host: '127.0.0.1',
  },
  adapters: {
    feishu: {
      enabled: false,
      appId: '',
      appSecret: '',
      mode: 'ws',
      domain: undefined,
      encryptKey: '',
      verificationToken: '',
      port: 17866,
      host: '127.0.0.1',
      path: '/feishu/event',
      allowedChatTypes: ['p2p', 'group'],
      groupMentionOnly: true,
      // 单个资源（图片/语音/文件）的下载上限，超过就跳过并在聊天里说明。
      mediaMaxBytes: 20 * 1024 * 1024,
    },
    mock: { enabled: false },
  },
  security: {
    // 空 = 谁都不许用（fail closed）。这是刻意的：通道插件的默认姿态必须是拒绝。
    allowPeers: [],
    allowAll: false,
  },
  agent: {
    cwd: '',
    provider: '',
    model: '',
  },
  behavior: {
    maxTurnMs: 30 * 60_000,
    progressAfterMs: 25_000,
    progressCards: true,
    allowApprovalCards: true,
    dismissGuiCard: true,
    cardTimeoutMs: 30 * 60_000,
    allowQuestions: true,
    // 媒体开关。关掉任何一个，对应类型的入站消息都会在聊天里得到明确说明，
    // 而不是"石沉大海"。
    media: {
      images: true,
      files: true,
      audio: true,
      imageMaxBytes: 10 * 1024 * 1024,
    },
    chunkLimit: 6400,
    maxQueueDepth: 8,
    journal: true,
  },
}

/** DSH 的状态根：优先 DSH_HOME，其次 ~/.dsh。 */
export function resolveDshHome(env = process.env) {
  const configured = env.DSH_HOME?.trim()
  return configured !== undefined && configured !== '' ? configured : join(homedir(), '.dsh')
}

export function resolveStateDir({ config, env = process.env }) {
  const explicit = config?.stateDir?.trim?.()
  if (explicit !== undefined && explicit !== '') return explicit
  return join(resolveDshHome(env), 'channel-hub')
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 深合并：数组整体替换（白名单不该被合并成两份）。 */
export function mergeConfig(...sources) {
  const out = {}
  for (const source of sources) {
    if (!isPlainObject(source)) continue
    for (const [key, value] of Object.entries(source)) {
      if (isPlainObject(value) && isPlainObject(out[key])) out[key] = mergeConfig(out[key], value)
      else out[key] = value
    }
  }
  return out
}

const ENV_MAP = [
  ['DSH_HUB_FEISHU_APP_ID', 'adapters.feishu.appId'],
  ['DSH_HUB_FEISHU_APP_SECRET', 'adapters.feishu.appSecret'],
  ['DSH_HUB_FEISHU_MODE', 'adapters.feishu.mode'],
  ['DSH_HUB_CWD', 'agent.cwd'],
  ['DSH_HUB_ALLOW_ALL', 'security.allowAll'],
]

function setPath(target, path, value) {
  const parts = path.split('.')
  let node = target
  for (const part of parts.slice(0, -1)) {
    if (!isPlainObject(node[part])) node[part] = {}
    node = node[part]
  }
  node[parts[parts.length - 1]] = value
}

/**
 * 把 patch config + config.json + 环境变量合成最终配置。
 *
 * @param {{patchConfig?: object, stateDir: string, env?: NodeJS.ProcessEnv}} input
 */
export function loadConfig({ patchConfig, stateDir, env = process.env }) {
  const fileConfig = readJson(join(stateDir, 'config.json'), {})
  const merged = mergeConfig(DEFAULTS, patchConfig ?? {}, fileConfig)
  for (const [name, path] of ENV_MAP) {
    const value = env[name]
    if (value === undefined || value === '') continue
    setPath(merged, path, path === 'security.allowAll' ? value === '1' || value.toLowerCase() === 'true' : value)
  }
  if (merged.agent.cwd === '') merged.agent.cwd = env.DSH_HUB_CWD ?? process.cwd()
  return merged
}

/** 把一小段配置合并进 config.json（控制台页面用）。 */
export function patchConfigFile(stateDir, patch) {
  const file = join(stateDir, 'config.json')
  const current = readJson(file, {})
  writeJsonAtomic(file, mergeConfig(current, patch))
  return file
}

/** 写一份带注释的初始 config.json（doctor --init 用）。 */
export function ensureConfigFile(stateDir) {
  mkdirSync(stateDir, { recursive: true })
  const file = join(stateDir, 'config.json')
  if (existsSync(file)) return file
  const template = {
    adapters: {
      feishu: {
        enabled: true,
        appId: 'cli_xxxxxxxxxxxx',
        appSecret: '请填飞书应用的 App Secret',
        mode: 'ws',
      },
    },
    security: { allowPeers: [], allowAll: false },
    agent: { cwd: '' },
  }
  writeFileSync(file, `${JSON.stringify(template, null, 2)}\n`, { mode: 0o600 })
  try { chmodSync(file, 0o600) } catch { /* Windows 上 chmod 基本无效，忽略 */ }
  return file
}

/**
 * 配置体检。
 *
 * 区分两档，因为它们的后果完全不同：
 *  - problems：**装了但一定不会工作**（缺 appId、白名单为空）→ 不启动适配器，只记日志。
 *  - warnings：**能跑，但大概率不是用户想要的**（没启用适配器）→ 照常启动。
 *
 * @returns {{problems: string[], warnings: string[]}}
 */
export function validateConfig(config) {
  const problems = []
  const warnings = []
  const feishu = config.adapters?.feishu ?? {}
  if (feishu.enabled === true) {
    if (!feishu.appId || feishu.appId.startsWith('cli_xxx')) problems.push('adapters.feishu.appId 还没填（飞书开放平台 → 凭证与基础信息）')
    if (!feishu.appSecret || feishu.appSecret.includes('请填') || feishu.appSecret.includes('在这里填')) problems.push('adapters.feishu.appSecret 还没填')
    if (feishu.mode !== 'ws' && feishu.mode !== 'webhook') problems.push(`adapters.feishu.mode 只能是 ws 或 webhook，当前是 ${String(feishu.mode)}`)
    if (feishu.mode === 'webhook' && !feishu.verificationToken) problems.push('webhook 模式需要 verificationToken（飞书事件订阅里配置）')
  }
  const mock = config.adapters?.mock ?? {}
  if (feishu.enabled !== true && mock.enabled !== true) {
    warnings.push('没有启用任何适配器，插件处于待配置状态（adapters.feishu.enabled = true 即启用）')
  }
  const allow = config.security?.allowPeers
  if (config.security?.allowAll !== true && (!Array.isArray(allow) || allow.length === 0)) {
    problems.push('security.allowPeers 为空：这是"谁都不回"的安全默认值。先在聊天里发 /id 拿到 peer id，再填进来（或确认要开 allowAll）')
  }
  if (typeof config.behavior?.maxTurnMs !== 'number' || config.behavior.maxTurnMs <= 0) problems.push('behavior.maxTurnMs 必须是正数')
  return { problems, warnings }
}
