#!/usr/bin/env node
/**
 * 命令行工具：安装前体检、生成配置、放行 peer。
 *
 * 设计原则：**每条命令都要能在没有 DSH 的情况下跑**。用户往往是在
 * "机器人不回我"的时候才想起它，这时候能跑起来比什么都重要。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'

const [, , command = 'help', ...args] = process.argv
const STATE_DIR = process.env.DSH_HUB_STATE_DIR ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'channel-hub')
const CONFIG_FILE = join(STATE_DIR, 'config.json')

const green = (text) => `\u001b[32m${text}\u001b[0m`
const red = (text) => `\u001b[31m${text}\u001b[0m`
const yellow = (text) => `\u001b[33m${text}\u001b[0m`
const dim = (text) => `\u001b[2m${text}\u001b[0m`

function readConfig() {
  if (!existsSync(CONFIG_FILE)) return undefined
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
  } catch (error) {
    return { __parseError: String(error) }
  }
}

function saveConfig(config) {
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
}

function initials() {
  const config = readConfig()
  if (config === undefined) {
    saveConfig({
      adapters: {
        feishu: { enabled: true, appId: 'cli_xxxxxxxxxxxx', appSecret: '在这里填 App Secret', mode: 'ws' },
        mock: { enabled: false },
      },
      security: { allowPeers: [], allowAll: false },
      agent: { cwd: '' },
    })
    console.log(green(`已生成配置模板：${CONFIG_FILE}`))
    console.log(dim('   填好 appId / appSecret，然后跑 `node bin/cli.mjs doctor`'))
  } else {
    console.log(yellow(`配置已存在，未覆盖：${CONFIG_FILE}`))
  }
}

async function doctor() {
  const checks = []
  const add = (name, ok, detail) => checks.push({ name, ok, detail })

  const [major, minor] = process.versions.node.split('.').map(Number)
  add('Node 版本 ≥ 22.13', major > 22 || (major === 22 && minor >= 13), `当前 ${process.versions.node}`)

  const config = readConfig()
  add('存在配置文件', config !== undefined, CONFIG_FILE)
  if (config?.__parseError !== undefined) add('配置文件是合法 JSON', false, config.__parseError)

  const feishu = config?.adapters?.feishu
  const mock = config?.adapters?.mock
  const anyAdapter = feishu?.enabled === true || mock?.enabled === true
  add('启用了至少一个适配器', anyAdapter, `feishu=${String(feishu?.enabled)} mock=${String(mock?.enabled)}`)

  if (feishu?.enabled === true) {
    const appId = typeof feishu.appId === 'string' ? feishu.appId : ''
    add('飞书 appId 已填', /^cli_[0-9a-zA-Z]{8,}$/.test(appId) && !appId.startsWith('cli_xxxx'), appId === '' ? '(缺失)' : appId)
    const secret = typeof feishu.appSecret === 'string' ? feishu.appSecret : ''
    add('飞书 appSecret 已填', secret.length > 10 && !secret.includes('填'), '(已隐藏)')
    add('飞书连接模式合法', feishu.mode === 'ws' || feishu.mode === 'webhook', feishu.mode ?? '(缺失)')
  }

  const allow = config?.security?.allowPeers
  add(
    '白名单非空（否则谁都不回）',
    config?.security?.allowAll === true || (Array.isArray(allow) && allow.length > 0),
    config?.security?.allowAll === true ? 'allowAll=true' : `allowPeers=${JSON.stringify(allow ?? [])}`,
  )

  let sdkOk = false
  let sdkDetail = ''
  try {
    const sdk = await import('@larksuiteoapi/node-sdk')
    sdkOk = typeof sdk.WSClient === 'function'
    sdkDetail = `@larksuiteoapi/node-sdk ${sdk.WSClient !== undefined ? '已加载' : '缺 WSClient'}`
  } catch (error) {
    sdkDetail = String(error).slice(0, 160)
  }
  add('飞书 SDK 可加载', sdkOk, sdkDetail)

  add('状态目录可写', canWrite(join(STATE_DIR, '.write-test')), STATE_DIR)

  // 控制台是配置入口，能访问说明插件已经加载起来了。
  const adminPort = config?.admin?.port ?? 17867
  const adminAlive = await fetch(`http://127.0.0.1:${adminPort}/health`, { signal: AbortSignal.timeout(2000) })
    .then((response) => response.ok)
    .catch(() => false)
  add('控制台可访问', adminAlive, adminAlive ? `http://127.0.0.1:${adminPort}` : `端口 ${adminPort} 无响应（DSH 没运行，或改过 admin.port）`)

  let failed = 0
  console.log(`\n${dim('dsh-channel-hub doctor')}`)
  for (const check of checks) {
    if (!check.ok) failed += 1
    console.log(`${check.ok ? green('✔') : red('✖')} ${check.name}${check.detail === undefined ? '' : `  ${dim(check.detail)}`}`)
  }
  console.log('')
  if (failed === 0) {
    console.log(green(`全部通过（${checks.length} 项）`))
    console.log(dim(`打开控制台：node bin/cli.mjs ui`))
  } else {
    console.log(red(`${failed}/${checks.length} 项未通过`))
    console.log(dim('日志：' + join(STATE_DIR, 'logs')))
    console.log(dim('可视化配置：node bin/cli.mjs ui'))
  }
  process.exitCode = failed === 0 ? 0 : 1
}

function canWrite(probe) {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(probe, 'ok')
    return true
  } catch {
    return false
  }
}

async function allow(peerKey) {
  if (peerKey === undefined || peerKey === '') {
    console.log(red('用法：node bin/cli.mjs allow feishu:oc_xxxxxxxx'))
    process.exitCode = 1
    return
  }
  const config = readConfig() ?? {}
  config.security ??= {}
  const list = Array.isArray(config.security.allowPeers) ? config.security.allowPeers : []
  if (!list.includes(peerKey)) {
    list.push(peerKey)
    config.security.allowPeers = list
    saveConfig(config)
  }
  // 控制台在跑就顺带热生效 —— 白名单改动本身不需要重启。
  try {
    await consoleApi('/api/allow', { method: 'POST', body: { peerKey } })
    if (!wantsJson) console.log(green(`已放行 ${peerKey}（立即生效）`))
    else console.log(JSON.stringify({ ok: true, peerKey, applied: true }))
  } catch {
    if (!wantsJson) {
      console.log(green(`已写入白名单：${peerKey}`))
      console.log(dim('控制台没在跑，重启 DSH 后生效。'))
    } else {
      console.log(JSON.stringify({ ok: true, peerKey, applied: false }))
    }
  }
}

function showConfig() {
  const config = readConfig()
  if (config === undefined) {
    console.log(yellow('还没有配置文件，先跑 `node bin/cli.mjs init`'))
    return
  }
  const redacted = JSON.parse(JSON.stringify(config))
  if (redacted?.adapters?.feishu?.appSecret !== undefined) {
    redacted.adapters.feishu.appSecret = '***'
  }
  console.log(JSON.stringify(redacted, null, 2))
  console.log(dim(`\n来自 ${CONFIG_FILE}`))
}

// ─── 给脚本/agent 用的命令 ────────────────────────────────────────────────
// 设计目标：**每一条都能被程序调用**（`--json` + 退出码），这样在对话里
// 说一句"连接飞书"，agent 就能按 status → setup → connect → allow 走完，
// 不需要人肉点界面，也不需要解析人话输出。

const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  if (index === -1) return fallback
  const value = args[index + 1]
  return value === undefined || value.startsWith('--') ? true : value
}
const wantsJson = args.includes('--json')

/** 控制台 API 的 token：优先读落盘文件（重启后不变），退回日志扫描。 */
function adminToken() {
  try {
    const token = readFileSync(join(STATE_DIR, 'admin-token'), 'utf8').trim()
    if (/^[0-9a-f]{36}$/.test(token)) return token
  } catch { /* 没落盘就扫日志 */ }
  try {
    const url = consoleUrlFromLogs(0)
    return new URL(url).searchParams.get('token') ?? undefined
  } catch {
    return undefined
  }
}

async function consoleApi(path, { method = 'GET', body } = {}) {
  const config = readConfig() ?? {}
  const port = flag('port', config.admin?.port ?? 17867)
  const token = adminToken()
  if (token === undefined) throw new Error('找不到控制台 token（DSH 可能没启动过）')
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-hub-token': token },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  })
  const json = await response.json().catch(() => ({}))
  if (!response.ok || json.ok === false) throw new Error(json.error ?? `HTTP ${response.status}`)
  return json
}

/** 一次性看全状态（配置 + 控制台 + 连接）。 */
async function status() {
  const config = readConfig()
  const feishu = config?.adapters?.feishu ?? {}
  const result = {
    installed: existsSync(join(STATE_DIR, 'config.json')),
    stateDir: STATE_DIR,
    config: {
      enabled: feishu.enabled === true,
      configured: typeof feishu.appId === 'string' && /^cli_[0-9a-zA-Z]{8,}$/.test(feishu.appId) && !feishu.appId.startsWith('cli_xxxx'),
      appId: feishu.appId ?? '',
      mode: feishu.mode ?? 'ws',
      allowPeers: config?.security?.allowPeers ?? [],
      cwd: config?.agent?.cwd ?? '',
    },
    console: { alive: false, url: undefined },
    connection: { state: 'unknown' },
    peers: [],
  }
  try {
    const port = config?.admin?.port ?? 17867
    const health = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) })
    result.console.alive = health.ok
    if (result.console.alive) {
      const token = adminToken()
      result.console.url = `http://127.0.0.1:${port}/?token=${token ?? ''}`
      const snapshot = await consoleApi('/api/state')
      result.connection = { state: snapshot.feishu?.state, since: snapshot.feishu?.since, error: snapshot.feishu?.error }
      result.peers = (snapshot.peers ?? []).map((peer) => ({ peerKey: peer.peerKey, allowed: peer.allowed, turns: peer.turns }))
      result.pending = snapshot.pending ?? []
      result.outbox = snapshot.stats?.outbox ?? 0
    }
  } catch (error) {
    result.console.error = String(error?.message ?? error)
  }
  if (wantsJson) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log(`${dim('配置')}      ${result.config.configured ? green('已配置') : red('未配置')}  ${result.config.appId || ''}  ${result.config.mode}`)
    console.log(`${dim('启用')}      ${result.config.enabled ? green('是') : red('否')}`)
    console.log(`${dim('控制台')}    ${result.console.alive ? green('运行中') : yellow('未运行')}  ${result.console.url ?? ''}`)
    console.log(`${dim('连接')}      ${result.connection.state === 'connected' ? green('已连接') : yellow(result.connection.state ?? '未知')}  ${result.connection.since ?? ''}`)
    console.log(`${dim('白名单')}    ${result.config.allowPeers.length === 0 ? red('空（谁都不回）') : result.config.allowPeers.join(', ')}`)
    if (result.peers.length > 0) {
      console.log(dim('会话'))
      for (const peer of result.peers) console.log(`            ${peer.allowed ? green('✔') : yellow('·')} ${peer.peerKey}  ${peer.turns} 轮`)
    }
  }
}

/**
 * 一条命令配好飞书：验证凭证 → 写配置 → 触发连接。
 *
 * 不碰安装：装插件是 `install.mjs` 的事，这里只管"把凭证接上"。
 */
async function setup() {
  const appId = flag('app-id')
  const appSecret = flag('app-secret')
  const mode = flag('mode', 'ws')
  const cwd = flag('cwd')
  const allowPeer = flag('allow')
  const report = { ok: false, steps: [] }

  if (typeof appId !== 'string' || typeof appSecret !== 'string') {
    const message = '用法：node bin/cli.mjs setup --app-id cli_xxx --app-secret xxx [--mode ws] [--cwd D] [--allow feishu:oc_x]'
    if (wantsJson) console.log(JSON.stringify({ ok: false, error: message }))
    else console.log(red(message))
    process.exitCode = 1
    return
  }

  // 1. 真去飞书换一次 token —— 凭证不对就别往配置里写。
  let bot
  try {
    const { verifyFeishuCredentials } = await import('../src/admin.js')
    const verified = await verifyFeishuCredentials({ appId, appSecret })
    if (verified.ok !== true) throw new Error(verified.error)
    bot = verified.bot
    report.steps.push({ step: 'verify', ok: true, bot: bot?.name })
  } catch (error) {
    report.steps.push({ step: 'verify', ok: false, error: String(error?.message ?? error) })
    if (wantsJson) console.log(JSON.stringify(report, null, 2))
    else console.log(red(`凭证校验失败：${String(error?.message ?? error)}`))
    process.exitCode = 1
    return
  }

  // 2. 写配置（合并，不动别的字段）。
  const config = readConfig() ?? {}
  config.adapters ??= {}
  config.adapters.feishu = {
    ...(config.adapters.feishu ?? {}),
    enabled: true,
    appId,
    appSecret,
    mode: mode === 'webhook' ? 'webhook' : 'ws',
    ...(bot?.name === undefined ? {} : { botName: bot.name }),
  }
  if (typeof cwd === 'string') {
    config.agent ??= {}
    config.agent.cwd = cwd
  }
  if (typeof allowPeer === 'string') {
    config.security ??= {}
    const list = Array.isArray(config.security.allowPeers) ? config.security.allowPeers : []
    if (!list.includes(allowPeer)) list.push(allowPeer)
    config.security.allowPeers = list
  }
  saveConfig(config)
  report.steps.push({ step: 'config', ok: true, file: CONFIG_FILE })

  // 3. 控制台在跑就直接连（不用重启）。
  try {
    await consoleApi('/api/connect', { method: 'POST', body: {} })
    report.steps.push({ step: 'connect', ok: true })
    report.ok = true
  } catch (error) {
    report.steps.push({ step: 'connect', ok: false, error: String(error?.message ?? error), hint: '配置已写好；重启 DSH 后会自动连接' })
    report.ok = true // 配置成功就算成功，连接可以等重启
  }

  if (wantsJson) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(green(`✔ 凭证有效${bot?.name === undefined ? '' : `：${bot.name}`}`))
    console.log(green(`✔ 配置已写入 ${CONFIG_FILE}`))
    const connect = report.steps.find((step) => step.step === 'connect')
    if (connect?.ok) console.log(green('✔ 已触发连接'))
    else console.log(yellow(`· 连接未触发（${connect?.error ?? ''}）；重启 DSH 后会自动连`))
    console.log(dim('\n下一步：在飞书里给机器人发一句话，然后 node bin/cli.mjs status 看是否出现会话'))
  }
  process.exitCode = report.ok ? 0 : 1
}

async function connectOrDisconnect(action) {
  try {
    const result = await consoleApi(`/api/${action}`, { method: 'POST', body: {} })
    if (wantsJson) console.log(JSON.stringify(result, null, 2))
    else console.log(green(action === 'connect' ? '已触发连接' : '已断开'))
  } catch (error) {
    const message = String(error?.message ?? error)
    if (wantsJson) console.log(JSON.stringify({ ok: false, error: message }))
    else console.log(red(`操作失败：${message}`))
    process.exitCode = 1
  }
}

/** 从最新日志里找出控制台 URL（token 只在那里出现）。 */
function consoleUrlFromLogs(port) {
  try {
    const dir = join(STATE_DIR, 'logs')
    const names = readdirSync(dir).filter((name) => name.endsWith('.log')).sort()
    for (const name of names.reverse()) {
      const text = readFileSync(join(dir, name), 'utf8')
      const matches = [...text.matchAll(/控制台：(http:\/\/[^\s]+token=[0-9a-f]+)/g)]
      if (matches.length > 0) return matches[matches.length - 1][1]
    }
  } catch {
    /* 没有日志就退回无 token 的地址，页面会提示未授权 */
  }
  return `http://127.0.0.1:${port}/`
}

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const EDGE64 = 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const CHROME64 = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'

/**
 * 打开控制台。
 *
 * 优先用 Edge/Chrome 的 `--app` 模式：没有地址栏、没有标签页，看起来就是一个
 * 独立的小浮窗（也正是它该有的样子 —— 一个本地工具面板，不是网页）。
 * 找不到就退回系统默认浏览器。
 */
function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      const appWindow = [EDGE, EDGE64, CHROME, CHROME64].find((candidate) => existsSync(candidate))
      if (appWindow !== undefined) {
        spawn(appWindow, [`--app=${url}`, '--window-size=560,820'], { stdio: 'ignore', detached: true }).unref()
        return true
      }
      spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref()
      return true
    }
    const command = process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]]
    spawn(command[0], command[1], { stdio: 'ignore', detached: true }).unref()
    return true
  } catch {
    return false
  }
}

/** 打开可视化控制台（插件进程里起的那个网页）。 */
async function ui() {
  const config = readConfig()
  const portFlag = args.includes('--port') ? Number(args[args.indexOf('--port') + 1]) : undefined
  const port = Number.isFinite(portFlag) ? portFlag : (config?.admin?.port ?? 17867)
  const health = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2500) })
    .then((response) => response.ok)
    .catch(() => false)
  if (!health) {
    console.log(yellow(`控制台 ${port} 端口没有响应。`))
    console.log('  1. 确认 DSH 正在运行（控制台是插件起的，DSH 不在就没有）')
    console.log('  2. 如果改过 admin.port，用 --port 指一下：node bin/cli.mjs ui --port 17867')
    console.log(dim(`  日志目录：${join(STATE_DIR, 'logs')}`))
    process.exitCode = 1
    return
  }
  const url = consoleUrlFromLogs(port)
  console.log(green('正在打开控制台：') + url)
  if (!openBrowser(url)) console.log(dim('自动打开失败，请手动访问上面的地址。'))
}

switch (command) {
  case 'init':
    initials()
    break
  case 'doctor':
    await doctor()
    break
  case 'allow':
    allow(args[0])
    break
  case 'config':
    showConfig()
    break
  case 'ui':
    await ui()
    break
  // 给脚本 / agent 用的（都支持 --json 与退出码）
  case 'status':
    await status()
    break
  case 'setup':
    await setup()
    break
  case 'connect':
    await connectOrDisconnect('connect')
    break
  case 'disconnect':
    await connectOrDisconnect('disconnect')
    break
  default:
    console.log('用法：node bin/cli.mjs <命令> [参数]')
    console.log('')
    console.log('  人用：')
    console.log('    ui                         打开可视化控制台')
    console.log('    doctor                     十项体检')
    console.log('    init                       生成配置模板')
    console.log('    config                     显示配置（secret 打码）')
    console.log('    allow <peerKey>            放行一个聊天窗口（控制台在跑就立即生效）')
    console.log('')
    console.log('  脚本 / agent 用（都支持 --json）：')
    console.log('    status                     一次性看全状态')
    console.log('    setup --app-id cli_x --app-secret y [--mode ws] [--cwd D] [--allow feishu:oc_x]')
    console.log('                               验证凭证 → 写配置 → 触发连接')
    console.log('    connect | disconnect       热连/断开（不重启 DSH）')
    process.exitCode = command === 'help' ? 0 : 1
}
