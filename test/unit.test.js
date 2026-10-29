import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildApprovalCard, buildCard, buildQuestionCard, chunkText, preferCard, toPlainText, truncate } from '../src/format.js'
import { SessionRouter, sessionIdFor } from '../src/router.js'
import { PeerQueue } from '../src/queue.js'
import { mergeConfig, validateConfig, loadConfig } from '../src/config.js'
import { SeenSet } from '../src/store.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'hub-test-'))

test('chunkText 不切断代码块，并在围栏处补齐闭合', () => {
  const code = ['```js', ...Array.from({ length: 40 }, (_, i) => `const v${i} = ${i}`), '```'].join('\n')
  const chunks = chunkText(`前言\n${code}\n后记`, 120)
  assert.ok(chunks.length >= 2, '应该被拆成多段')
  for (const chunk of chunks) {
    const fences = (chunk.match(/```/g) ?? []).length
    assert.equal(fences % 2, 0, `每段里的代码围栏必须成对：\n${chunk}`)
  }
  const reassembled = chunks.join('\n')
  for (let i = 0; i < 40; i += 1) {
    assert.ok(reassembled.includes(`const v${i} = ${i}`), `第 ${i} 行不应丢失`)
  }
  assert.ok(reassembled.startsWith('前言'))
  assert.ok(reassembled.includes('后记'))
})

test('chunkText 对空串返回空数组，对短文本原样返回', () => {
  assert.deepEqual(chunkText(''), [])
  assert.deepEqual(chunkText('   '), [])
  assert.deepEqual(chunkText('你好'), ['你好'])
})

test('chunkText 硬切超长单行', () => {
  const line = 'x'.repeat(250)
  const chunks = chunkText(line, 100)
  assert.equal(chunks.length, 3)
  assert.equal(chunks.join(''), line)
})

test('preferCard 区分短句与结构化内容', () => {
  assert.equal(preferCard('好的，已完成。'), false)
  assert.equal(preferCard('## 标题\n- 一\n- 二'), true)
  assert.equal(preferCard('```js\n1\n```'), true)
  assert.equal(preferCard('x'.repeat(300)), true)
})

test('toPlainText 去掉 markdown 装饰', () => {
  assert.equal(toPlainText('**粗** `code` [a](http://b)'), '粗 code a (http://b)')
  assert.equal(toPlainText('# 标题'), '标题')
})

test('truncate 折叠空白并加省略号', () => {
  assert.equal(truncate('a   b\n c', 10), 'a b c')
  assert.equal(truncate('x'.repeat(20), 5), 'xxxx…')
})

test('buildCard 带标题、按钮与脚注', () => {
  const card = buildCard({
    title: 't',
    color: 'green',
    markdown: 'body',
    footer: 'f',
    actions: [[{ label: 'OK', type: 'primary', value: { hub: 'approve', id: 'A1' } }]],
  })
  assert.equal(card.header.template, 'green')
  assert.equal(card.header.title.content, 't')
  assert.equal(card.elements[0].content, 'body')
  assert.equal(card.elements[1].tag, 'action')
  assert.equal(card.elements[1].actions[0].value.hub, 'approve')
  assert.equal(card.elements[2].tag, 'hr')
  assert.equal(card.config.update_multi, true)
})

test('buildApprovalCard 的按钮 value 指向我们自己的卡片 id', () => {
  const card = buildApprovalCard({ id: 'Aabc123', toolName: 'pwsh', reason: '需要网络', index: 1, total: 2 })
  const buttons = card.elements.find((element) => element.tag === 'action').actions
  assert.deepEqual(buttons.map((button) => button.value), [
    { hub: 'approve', id: 'Aabc123' },
    { hub: 'deny', id: 'Aabc123' },
  ])
  assert.match(card.header.title.content, /1\/2/)
})

test('buildQuestionCard 少量选项给按钮，多选项退回文本', () => {
  const carded = buildQuestionCard({ id: 'Q1', question: '走哪条？', options: ['A', 'B'] })
  assert.ok(carded.card !== undefined)
  assert.equal(carded.card.elements.find((element) => element.tag === 'action').actions.length, 2)

  const texted = buildQuestionCard({ id: 'Q2', question: '选一个', options: ['1', '2', '3', '4', '5', '6'] })
  assert.equal(texted.card, undefined)
  assert.match(texted.text, /6\. 6/)
})

test('sessionIdFor 确定性且可做文件名', () => {
  const a = sessionIdFor('feishu:oc_123')
  const b = sessionIdFor('feishu:oc_123')
  assert.equal(a, b)
  assert.notEqual(a, sessionIdFor('feishu:oc_124'))
  assert.match(a, /^hub-[0-9a-f]{12}-g0$/)
  assert.equal(sessionIdFor('feishu:oc_123', 3), a.replace('-g0', '-g3'))
})

test('SessionRouter：首次取用即落盘，/new 只加代次，标题只记第一次', () => {
  const dir = tmp()
  const file = join(dir, 'sessions.json')
  const router = new SessionRouter({ file })
  const first = router.ensure('feishu:oc_a', { cwd: 'C:/work' })
  assert.equal(first.generation, 0)
  assert.equal(first.cwd, 'C:/work')

  const again = new SessionRouter({ file }).ensure('feishu:oc_a')
  assert.equal(again.sessionId, first.sessionId, '重启后必须落到同一个会话')

  router.setTitleOnce('feishu:oc_a', '第一句话')
  router.setTitleOnce('feishu:oc_a', '第二句话')
  assert.equal(router.get('feishu:oc_a').title, '第一句话')

  const rotated = router.rotate('feishu:oc_a')
  assert.equal(rotated.generation, 1)
  assert.notEqual(rotated.sessionId, first.sessionId)
  assert.equal(router.peerForSession(first.sessionId), undefined, '旧代次不再被路由')
  assert.equal(router.peerForSession(rotated.sessionId), 'feishu:oc_a')
})

test('PeerQueue 严格串行，超深拒绝', async () => {
  const queue = new PeerQueue({ maxDepth: 2 })
  const order = []
  const first = queue.enqueue('k', async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
    order.push('first')
    return 1
  })
  const second = queue.enqueue('k', async () => {
    order.push('second')
    return 2
  })
  assert.throws(() => queue.enqueue('k', async () => {}), (error) => error.code === 'QUEUE_FULL')
  assert.equal(await first, 1)
  assert.equal(await second, 2)
  assert.deepEqual(order, ['first', 'second'])
  assert.equal(queue.isBusy('k'), false)
})

test('PeerQueue 一个任务抛错不会卡死队列', async () => {
  const queue = new PeerQueue()
  const failed = queue.enqueue('k', async () => { throw new Error('boom') })
  await assert.rejects(failed, /boom/)
  assert.equal(await queue.enqueue('k', async () => 'ok'), 'ok')
})

test('SeenSet 有界淘汰', () => {
  const seen = new SeenSet(2)
  assert.equal(seen.add('a'), true)
  assert.equal(seen.add('a'), false)
  seen.add('b')
  seen.add('c')
  assert.equal(seen.size, 2)
  assert.equal(seen.has('a'), false, '最老的应被淘汰')
})

test('mergeConfig 深合并，数组整体替换', () => {
  const merged = mergeConfig(
    { security: { allowPeers: ['a'], allowAll: false }, adapters: { feishu: { enabled: false, mode: 'ws' } } },
    { security: { allowPeers: ['b'] }, adapters: { feishu: { enabled: true } } },
  )
  assert.deepEqual(merged.security.allowPeers, ['b'])
  assert.equal(merged.adapters.feishu.enabled, true)
  assert.equal(merged.adapters.feishu.mode, 'ws')
})

test('validateConfig 把"会静默不工作"的配置变成人话', () => {
  const { problems, warnings } = validateConfig({
    adapters: { feishu: { enabled: true, appId: 'cli_xxx', appSecret: '请填飞书应用的 App Secret' } },
    security: { allowPeers: [] },
    behavior: { maxTurnMs: 1 },
  })
  assert.ok(problems.some((item) => item.includes('appId')))
  assert.ok(problems.some((item) => item.includes('appSecret')))
  assert.ok(problems.some((item) => item.includes('allowPeers')))
  assert.deepEqual(warnings, [])
})

test('validateConfig：没启用适配器只是警告，不是故障', () => {
  const { problems, warnings } = validateConfig({
    adapters: { feishu: { enabled: false } },
    security: { allowAll: true },
    behavior: { maxTurnMs: 1000 },
  })
  assert.deepEqual(problems, [])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /待配置状态/)
})

test('loadConfig 三层优先级：环境变量 > 文件 > patch', () => {
  const dir = tmp()
  const config = loadConfig({
    stateDir: dir,
    patchConfig: { behavior: { maxTurnMs: 1000 }, security: { allowPeers: ['patch'] } },
    env: { DSH_HUB_FEISHU_APP_ID: 'cli_from_env' },
  })
  assert.equal(config.behavior.maxTurnMs, 1000)
  assert.deepEqual(config.security.allowPeers, ['patch'])
  assert.equal(config.adapters.feishu.appId, 'cli_from_env')
})
