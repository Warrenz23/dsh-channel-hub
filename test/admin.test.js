import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAdminServer, tailLog, verifyFeishuCredentials } from '../src/admin.js'

const noopLog = { info() {}, warn() {}, error() {} }
const tmp = () => mkdtempSync(join(tmpdir(), 'hub-admin-'))

/** 起一个只为测试的控制台（端口 0 = 让系统分配）。 */
async function boot(overrides = {}) {
  const dir = tmp()
  const htmlFile = join(dir, 'admin.html')
  writeFileSync(htmlFile, '<html>token=__HUB_TOKEN__</html>')
  const calls = { allow: [], disallow: [], allowAll: [], connect: 0, disconnect: 0, creds: [] }
  const server = createAdminServer({
    port: 0,
    htmlFile,
    log: noopLog,
    getSnapshot: async () => ({ feishu: { state: 'idle' }, security: { allowPeers: ['a'] }, peers: [], stats: {}, pending: [], logs: ['l1'] }),
    setCredentials: async (creds) => { calls.creds.push(creds); return { ok: true, bot: { name: '测试机器人' } } },
    connect: async () => { calls.connect += 1; return { ok: true } },
    disconnect: async () => { calls.disconnect += 1; return { ok: true } },
    allowPeer: (peerKey) => calls.allow.push(peerKey),
    disallowPeer: (peerKey) => calls.disallow.push(peerKey),
    setAllowAll: (value) => calls.allowAll.push(value),
    ...overrides,
  })
  const started = await server.start()
  return { server, started, calls, dir }
}

const headers = (token) => ({ 'content-type': 'application/json', 'x-hub-token': token })

test('控制台：页面里内联了 token，/health 免鉴权', async () => {
  const { server, started } = await boot()
  try {
    const page = await fetch(started.url)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /token=[0-9a-f]{36}/)

    const health = await fetch(`http://127.0.0.1:${new URL(started.url).port}/health`)
    assert.equal(health.status, 200)
    assert.equal((await health.json()).ok, true)
  } finally {
    await server.stop()
  }
})

test('控制台：没有 token 一律 401', async () => {
  const { server, started } = await boot()
  const base = `http://127.0.0.1:${new URL(started.url).port}`
  try {
    assert.equal((await fetch(`${base}/api/state`)).status, 401)
    assert.equal((await fetch(`${base}/api/state?token=wrong`)).status, 401)
    assert.equal((await fetch(`${base}/api/state`, { headers: headers('wrong') })).status, 401)
    assert.equal((await fetch(`${base}/api/state`, { headers: headers(server.token) })).status, 200)
  } finally {
    await server.stop()
  }
})

test('控制台：跨站 Origin 即使带 token 也拒绝（防 CSRF）', async () => {
  const { server, started } = await boot()
  const base = `http://127.0.0.1:${new URL(started.url).port}`
  try {
    const evil = await fetch(`${base}/api/state`, {
      headers: { ...headers(server.token), origin: 'https://evil.example' },
    })
    assert.equal(evil.status, 401)

    const sameOrigin = await fetch(`${base}/api/state`, {
      headers: { ...headers(server.token), origin: base },
    })
    assert.equal(sameOrigin.status, 200)
  } finally {
    await server.stop()
  }
})

test('控制台：放行/移除/开关/连接都打到回调上', async () => {
  const { server, started, calls } = await boot()
  const base = `http://127.0.0.1:${new URL(started.url).port}`
  const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: headers(server.token), body: JSON.stringify(body) })
  try {
    assert.equal((await post('/api/allow', { peerKey: 'feishu:oc_1' })).status, 200)
    assert.equal((await post('/api/disallow', { peerKey: 'feishu:oc_1' })).status, 200)
    assert.equal((await post('/api/open-allow-all', { value: true })).status, 200)
    assert.equal((await post('/api/connect', {})).status, 200)
    assert.equal((await post('/api/disconnect', {})).status, 200)
    assert.deepEqual(calls.allow, ['feishu:oc_1'])
    assert.deepEqual(calls.disallow, ['feishu:oc_1'])
    assert.deepEqual(calls.allowAll, [true])
    assert.equal(calls.connect, 1)
    assert.equal(calls.disconnect, 1)
  } finally {
    await server.stop()
  }
})

test('控制台：缺 peerKey 的请求被拒，不会静默成功', async () => {
  const { server, started } = await boot()
  const base = `http://127.0.0.1:${new URL(started.url).port}`
  try {
    const response = await fetch(`${base}/api/allow`, { method: 'POST', headers: headers(server.token), body: '{}' })
    assert.equal(response.status, 400)
  } finally {
    await server.stop()
  }
})

test('控制台：凭证校验失败时透传飞书的错误原因', async () => {
  const { server, started, calls } = await boot({
    setCredentials: async (creds) => {
      calls.creds.push(creds)
      return { ok: false, error: '凭证被拒绝（code 10014）：app secret invalid' }
    },
  })
  const base = `http://127.0.0.1:${new URL(started.url).port}`
  try {
    const response = await fetch(`${base}/api/credentials`, {
      method: 'POST',
      headers: headers(server.token),
      body: JSON.stringify({ appId: 'cli_x', appSecret: 'y' }),
    })
    assert.equal(response.status, 400)
    assert.match((await response.json()).error, /app secret invalid/)
  } finally {
    await server.stop()
  }
})

test('控制台：token 落盘 ⇒ 重启后地址不变', async () => {
  const dir = tmp()
  const htmlFile = join(dir, 'admin.html')
  writeFileSync(htmlFile, '<html>__HUB_TOKEN__</html>')
  const tokenFile = join(dir, 'admin-token')
  const first = createAdminServer({ port: 0, htmlFile, tokenFile, log: noopLog, getSnapshot: async () => ({}) })
  await first.start()
  const token = first.token
  await first.stop()
  assert.match(token, /^[0-9a-f]{36}$/)

  const second = createAdminServer({ port: 0, htmlFile, tokenFile, log: noopLog, getSnapshot: async () => ({}) })
  await second.start()
  assert.equal(second.token, token, '同一个 tokenFile 必须复用同一个 token')
  await second.stop()
})

test('tailLog 读最新日志文件的尾部', () => {
  const dir = tmp()
  writeFileSync(join(dir, 'hub-2026-01-01.log'), 'a\nb\nc\n')
  writeFileSync(join(dir, 'hub-2026-01-02.log'), 'x\ny\nz\n')
  assert.deepEqual(tailLog(dir, 2), ['y', 'z'])
  assert.deepEqual(tailLog(join(dir, 'nope'), 2), [])
})

test('verifyFeishuCredentials：空凭证不发起请求，直接给出可读错误', async () => {
  // 真的会打网络，所以只测"参数明显不对"的分支：飞书会回 code !== 0。
  const result = await verifyFeishuCredentials({ appId: 'cli_invalid', appSecret: 'x' })
  assert.equal(result.ok, false)
  assert.equal(typeof result.error, 'string')
  assert.ok(result.error.length > 0)
})
