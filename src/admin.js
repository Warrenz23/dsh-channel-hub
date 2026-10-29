/**
 * 本地控制台：把"填凭证 / 起连接 / 放行自己"做成一个网页。
 *
 * 为什么是网页而不是 DSH 内的面板：面板要走客户端插件（需要构建浏览器 bundle），
 * 而这个页面必须在**插件还没配置好**的时候就能打开 —— 那正是它存在的意义。
 * 所以它由插件自己在回环地址上起一个小 HTTP 服务，页面同源加载，零构建步骤。
 *
 * 安全约定（本机服务也要当公网服务写）：
 *  - 只 bind 127.0.0.1；
 *  - 所有 /api/* 都要 `x-hub-token`（页面里内联，SSE 用 query 传）；
 *  - 带 Origin 的请求必须是同源，挡掉随便哪个网站对你的 localhost 发 POST；
 *  - 凭证只落盘到 config.json（0600），接口返回永远打码。
 */
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

const TOKEN_HEADER = 'x-hub-token'

/** 校验飞书凭证：拿 tenant_access_token，再顺便问一下机器人名字。 */
export async function verifyFeishuCredentials({ appId, appSecret, domain }) {
  const base = domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn'
  const call = async (path, init) => {
    const response = await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(15_000) })
    const body = await response.json().catch(() => ({}))
    return { status: response.status, body }
  }
  let result
  try {
    result = await call('/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    })
  } catch (error) {
    return { ok: false, error: `连不上飞书开放平台：${String(error?.message ?? error)}` }
  }
  if (result.body?.code !== 0) {
    return {
      ok: false,
      error: `凭证被拒绝（code ${String(result.body?.code)}）：${String(result.body?.msg ?? '')}`,
    }
  }
  const token = result.body.tenant_access_token
  let bot
  try {
    const info = await call('/open-apis/bot/v3/info', { headers: { authorization: `Bearer ${token}` } })
    if (info.body?.code === 0) {
      bot = { name: info.body.bot?.app_name, openId: info.body.bot?.open_id, avatar: info.body.bot?.avatar_url }
    }
  } catch {
    /* 机器人信息只是锦上添花，拿不到不影响判断凭证是否有效 */
  }
  return { ok: true, bot }
}

/** 从日志目录取最新文件的后 N 行（UI 的"最近日志"）。 */
export function tailLog(dir, lines = 40) {
  try {
    const names = readdirSync(dir).filter((name) => name.endsWith('.log')).sort()
    if (names.length === 0) return []
    const text = readFileSync(join(dir, names[names.length - 1]), 'utf8')
    return text.trimEnd().split('\n').slice(-lines)
  } catch {
    return []
  }
}

/**
 * 控制台的 token。
 *
 * 落盘而不是每次随机：**重启 DSH 之后旧窗口不用换地址**（刷新即可），
 * 否则用户每重启一次就得重新翻日志找新 token —— 这恰恰是最烦的一步。
 * 文件 0600，内容就是那 36 个十六进制字符。
 */
function resolveToken(tokenFile) {
  if (tokenFile === undefined) return randomBytes(18).toString('hex')
  try {
    const existing = readFileSync(tokenFile, 'utf8').trim()
    if (/^[0-9a-f]{36}$/.test(existing)) return existing
  } catch {
    /* 不存在就生成 */
  }
  const token = randomBytes(18).toString('hex')
  try {
    mkdirSync(dirname(tokenFile), { recursive: true })
    writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 })
  } catch {
    /* 写不了就用内存里的，下次重启换新的 */
  }
  return token
}

/**
 * @param {object} options
 * @param {number} options.port
 * @param {string} [options.host]
 * @param {string} options.htmlFile
 * @param {(req: object) => Promise<any>} [options.getSnapshot]
 * @param {(creds: object) => Promise<any>} [options.setCredentials]
 * @param {() => Promise<any>} [options.connect]
 * @param {() => Promise<any>} [options.disconnect]
 * @param {(peerKey: string) => any} [options.allowPeer]
 * @param {(peerKey: string) => any} [options.disallowPeer]
 * @param {any} options.log
 */
export function createAdminServer(options) {
  const host = options.host ?? '127.0.0.1'
  const requestedPort = options.port ?? 17867
  const token = resolveToken(options.tokenFile)
  /** @type {Set<any>} */
  const clients = new Set()
  let server
  let startedAt
  let lastError
  /** 实际监听端口（传 0 时由系统分配，测试用）。 */
  let port = requestedPort

  const html = () => {
    try {
      return readFileSync(options.htmlFile, 'utf8').replaceAll('__HUB_TOKEN__', token)
    } catch (error) {
      return `<h1>控制台页面缺失</h1><pre>${String(error)}</pre>`
    }
  }

  const send = (res, status, body, type = 'application/json; charset=utf-8') => {
    const payload = typeof body === 'string' ? body : JSON.stringify(body)
    res.writeHead(status, {
      'content-type': type,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    res.end(payload)
  }

  const authorized = (req, url) => {
    const origin = req.headers.origin
    if (typeof origin === 'string' && origin !== '') {
      const allowed = [`http://${host}:${port}`, `http://localhost:${port}`, `http://127.0.0.1:${port}`]
      if (!allowed.includes(origin)) return false
    }
    const header = req.headers[TOKEN_HEADER]
    if (typeof header === 'string' && header === token) return true
    return url.searchParams.get('token') === token
  }

  const readJson = (req) => new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 1_000_000) reject(new Error('请求体过大'))
    })
    req.on('end', () => {
      if (body.trim() === '') return resolve({})
      try {
        resolve(JSON.parse(body))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })

  const publish = (event, data) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const res of clients) {
      try {
        res.write(frame)
      } catch {
        clients.delete(res)
      }
    }
  }

  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}:${port}`)
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return send(res, 200, html(), 'text/html; charset=utf-8')
      }
      if (url.pathname === '/health') return send(res, 200, { ok: true, since: startedAt })

      if (url.pathname.startsWith('/api/')) {
        if (!authorized(req, url)) return send(res, 401, { ok: false, error: 'unauthorized' })

        if (req.method === 'GET' && url.pathname === '/api/state') {
          const snapshot = await options.getSnapshot?.()
          return send(res, 200, { ok: true, ...snapshot })
        }
        if (req.method === 'GET' && url.pathname === '/api/events') {
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-store',
            connection: 'keep-alive',
          })
          res.write(`event: hello\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`)
          clients.add(res)
          const keepAlive = setInterval(() => {
            try { res.write(': ping\n\n') } catch { clients.delete(res) }
          }, 15_000)
          keepAlive.unref?.()
          req.on('close', () => {
            clearInterval(keepAlive)
            clients.delete(res)
          })
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/credentials') {
          const body = await readJson(req)
          const result = await options.setCredentials?.(body)
          return send(res, result?.ok === false ? 400 : 200, result ?? { ok: false, error: '未实现' })
        }
        if (req.method === 'POST' && url.pathname === '/api/connect') {
          const result = await options.connect?.()
          publish('state', await options.getSnapshot?.())
          return send(res, 200, result ?? { ok: true })
        }
        if (req.method === 'POST' && url.pathname === '/api/disconnect') {
          const result = await options.disconnect?.()
          publish('state', await options.getSnapshot?.())
          return send(res, 200, result ?? { ok: true })
        }
        if (req.method === 'POST' && url.pathname === '/api/allow') {
          const body = await readJson(req)
          if (typeof body.peerKey !== 'string') return send(res, 400, { ok: false, error: '缺少 peerKey' })
          options.allowPeer?.(body.peerKey)
          publish('state', await options.getSnapshot?.())
          return send(res, 200, { ok: true })
        }
        if (req.method === 'POST' && url.pathname === '/api/disallow') {
          const body = await readJson(req)
          if (typeof body.peerKey !== 'string') return send(res, 400, { ok: false, error: '缺少 peerKey' })
          options.disallowPeer?.(body.peerKey)
          publish('state', await options.getSnapshot?.())
          return send(res, 200, { ok: true })
        }
        if (req.method === 'POST' && url.pathname === '/api/open-allow-all') {
          const body = await readJson(req)
          options.setAllowAll?.(body.value === true)
          publish('state', await options.getSnapshot?.())
          return send(res, 200, { ok: true })
        }
        return send(res, 404, { ok: false, error: 'not found' })
      }
      return send(res, 404, { ok: false, error: 'not found' })
    } catch (error) {
      lastError = String(error?.message ?? error)
      options.log?.warn(`控制台请求失败 ${req.method} ${url.pathname}：${lastError}`)
      return send(res, 500, { ok: false, error: lastError })
    }
  })

  return {
    token,
    publish,
    /** @returns {Promise<{url: string} | undefined>} 端口被占用时返回 undefined。 */
    async start() {
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(requestedPort, host, resolve)
      }).catch((error) => {
        options.log?.warn(`控制台没起来（${host}:${requestedPort}）：${String(error)}`)
        return undefined
      })
      if (!server.listening) return undefined
      const address = server.address()
      if (address !== null && typeof address === 'object') port = address.port
      startedAt = new Date().toISOString()
      const url = `http://${host}:${port}/?token=${token}`
      options.log?.info(`控制台：${url}`)
      return { url }
    },
    async stop() {
      for (const res of clients) {
        try { res.end() } catch { /* 已断开 */ }
      }
      clients.clear()
      if (server.listening) await new Promise((resolve) => server.close(resolve))
    },
    get url() {
      return server.listening ? `http://${host}:${port}/?token=${token}` : undefined
    },
    lastError: () => lastError,
  }
}
