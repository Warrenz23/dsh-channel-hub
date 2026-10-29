#!/usr/bin/env node
/**
 * 离线演示：不需要飞书账号、不需要 DSH、不需要网络。
 *
 * 它跑的是**和生产完全一样的内核代码**（路由 / 队列 / 桥 / 卡片 / 出站），
 * 只是把"平台"换成了内存适配器、"模型"换成了会回话的假宿主。
 *
 *   node bin/demo.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFakeHost } from '../test/fake-host.js'
import { createHub } from '../src/index.js'
import { loadConfig } from '../src/config.js'
import { createMockAdapter } from '../src/adapters/mock.js'

const dim = (text) => `\u001b[2m${text}\u001b[0m`
const cyan = (text) => `\u001b[36m${text}\u001b[0m`
const green = (text) => `\u001b[32m${text}\u001b[0m`
const yellow = (text) => `\u001b[33m${text}\u001b[0m`

const stateDir = mkdtempSync(join(tmpdir(), 'hub-demo-'))
const log = { info: () => {}, warn: (m) => console.log(yellow(`  ! ${m}`)), error: (m) => console.log(yellow(`  ! ${m}`)), child() { return this } }

const host = createFakeHost({
  reply: async (text) => {
    if (text.includes('代码')) {
      return '给你一段：\n```js\nconst hub = createHub({ ctx, config })\nawait hub.start()\n```\n以上就是最小用法。'
    }
    if (text.includes('长')) {
      return Array.from({ length: 60 }, (_, i) => `第 ${i + 1} 行：这是一段用来演示分段的输出。`).join('\n')
    }
    return `收到：「${text}」。\n\n（这是假宿主的回答；在真 DSH 里这里会是 agent 干活的结果）`
  },
})

const config = loadConfig({
  stateDir,
  patchConfig: {
    adapters: { mock: { enabled: true } },
    security: { allowAll: false, allowPeers: [] },
    agent: { cwd: stateDir },
    behavior: { progressAfterMs: 0, journal: false, chunkLimit: 400 },
  },
  env: {},
})

let hub
const adapter = createMockAdapter({
  log,
  onInbound: (msg) => hub.handleInbound(msg),
  onCardAction: (action) => hub.handleCardAction(action),
})
hub = createHub({ ctx: host.ctx, config, stateDir, log, adapters: new Map([['mock', adapter]]) })

/** 把适配器的发送流水渲染成人能读的时间线。 */
function printSince(index) {
  for (const item of adapter.outbound.slice(index)) {
    if (item.kind === 'text') console.log(`${green('机器人 →')} ${item.text.split('\n')[0]}${item.text.includes('\n') ? dim(' …') : ''}`)
    else if (item.kind === 'card') {
      const title = item.card?.header?.title?.content ?? '(无标题)'
      const body = (item.card?.elements ?? []).find((element) => element.tag === 'markdown')?.content ?? ''
      console.log(`${cyan('卡片   →')} ${title}`)
      if (body !== '') console.log(dim(`           ${body.split('\n')[0]}`))
      const actions = (item.card?.elements ?? []).find((element) => element.tag === 'action')
      if (actions !== undefined) console.log(dim(`           ${actions.actions.map((button) => `[${button.text.content}]`).join(' ')}`))
    } else if (item.kind === 'update') {
      const body = (item.card?.elements ?? []).find((element) => element.tag === 'markdown')?.content ?? ''
      console.log(`${cyan('卡片   ↻')} ${dim(body.split('\n')[0])}`)
    }
  }
  return adapter.outbound.length
}

console.log(dim('══ dsh-channel-hub 离线演示（假宿主 + 内存通道） ══\n'))
await hub.start()

let cursor = 0
async function say(text, note) {
  console.log(`\n${yellow('你     →')} ${text}${note === undefined ? '' : dim(`   ${note}`)}`)
  const before = cursor
  await adapter.inject({ text })
  cursor = printSince(before)
}

console.log(dim('—— 1. 白名单为空时，插件拒绝一切（fail closed） ——'))
await say('你好')
cursor = printSince(cursor)

console.log(dim('\n—— 2. 放行之后，正常对话 ——'))
config.security.allowPeers = ['mock:chat1']
await say('帮我看看这个项目的结构')
cursor = adapter.outbound.length

console.log(dim('\n—— 3. 代码块会被包成卡片（保留 markdown 渲染） ——'))
await say('给我一段代码')

console.log(dim('\n—— 4. 长输出按段落切分，不切断代码块 ——'))
await say('来点长内容')

console.log(dim('\n—— 5. 图片：先过宿主准入，变成 durable 附件才进消息 ——'))
{
  const before = adapter.outbound.length
  console.log(`${yellow('你     →')} ${dim('[图片] 看看这张图')}`)
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
  await adapter.inject({ text: '看看这张图', images: [{ mediaType: 'image/png', data: png.toString('base64') }] })
  cursor = printSince(before)
  const content = host.messages.at(-1).content
  console.log(dim(`           agent 收到的内容块：${content.map((part) => (part.attachment === undefined ? part.type : `${part.type}(${part.attachment.id})`)).join(' + ')}`))
}

console.log(dim('\n—— 6. 插件内命令：不消耗模型回合 ——'))
await say('/status')

console.log(dim('\n—— 7. 审批卡：工具要权限时在聊天里点按钮 ——'))
const sessionId = hub.router.get('mock:chat1').sessionId
const agent = host.agents.get(sessionId)
const approval = host.requestApproval({ agent, toolName: 'pwsh', reason: '这条命令需要写工作区之外的文件' })
await new Promise((resolve) => setTimeout(resolve, 20))
cursor = printSince(cursor)
const card = adapter.outbound.filter((item) => item.kind === 'card').at(-1)
const approveButton = card.card.elements.find((element) => element.tag === 'action').actions[0]
console.log(`${yellow('你     →')} ${dim('（点击卡片上的按钮）')}`)
const result = await adapter.click({ value: approveButton.value })
await approval
console.log(`${green('机器人 →')} ${result.toast}`)

console.log(dim('\n══ 演示结束：以上全部由同一份内核代码驱动 ══'))
await hub.stop()
