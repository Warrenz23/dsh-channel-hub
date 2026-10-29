/**
 * 聊天内命令。
 *
 * 原则：命令**不消耗模型回合**，也不进上下文。用户在飞书里打 `/status`，
 * 期望是立刻看到状态，而不是"让 agent 想想"。所以这些都在插件里就地应答，
 * 只有普通消息才交给 agent。
 */

const HELP = [
  '**可用命令**',
  '/new — 开一个新会话（旧会话保留，不删除）',
  '/status — 当前会话状态、待处理卡片、出站队列',
  '/stop — 中断正在执行的那一轮',
  '/approve [ID] · /deny [ID] — 处理审批卡（只有一张卡时 ID 可省略）',
  '/id — 显示这个聊天窗口的 peer id（填白名单要用）',
  '/help — 这张表',
  '',
  '其余任何文字都会交给 agent 执行。',
].join('\n')

/** 命令表：名字 → 是否需要参数。 */
const COMMANDS = new Map([
  ['/help', false],
  ['/new', false],
  ['/status', false],
  ['/stop', false],
  ['/approve', true],
  ['/deny', true],
  ['/id', false],
])

/**
 * 尝试把一条消息当命令处理。
 *
 * @returns {Promise<{handled: boolean, reply?: string}>}
 */
export async function handleCommand({ text, peerKey, router, bridge, gate, adapters, outbox }) {
  const raw = String(text ?? '').trim()
  if (!raw.startsWith('/')) return { handled: false }
  const [name, ...rest] = raw.split(/\s+/)
  const known = COMMANDS.get(name.toLowerCase())
  if (known === undefined) return { handled: false }
  const arg = rest.join(' ').trim()

  switch (name.toLowerCase()) {
    case '/help':
      return { handled: true, reply: HELP }

    case '/id':
      return {
        handled: true,
        reply: `peer id：\`${peerKey}\`\n把这串填进配置的 \`security.allowPeers\` 里，就只允许这个聊天窗口使用。`,
      }

    case '/new': {
      const entry = router.rotate(peerKey)
      return { handled: true, reply: `🆕 已切换到新会话：\`${entry.sessionId}\`\n（上一个会话还在，随时可以在 DSH 里回看）` }
    }

    case '/status': {
      const entry = router.get(peerKey)
      const pending = gate?.pendingFor(peerKey) ?? []
      const lines = [
        bridge.describe(peerKey),
        `待处理卡片：${pending.length === 0 ? '无' : pending.map((item) => `${item.id}（${item.kind === 'approval' ? '审批' : '提问'}）`).join('、')}`,
        `出站队列：${outbox?.size?.() ?? 0} 条待重试`,
        `通道：${[...(adapters?.keys?.() ?? [])].join('、') || '（无）'}`,
      ]
      if (entry?.cwd !== undefined) lines.push(`工作目录：\`${entry.cwd}\``)
      return { handled: true, reply: lines.join('\n') }
    }

    case '/stop':
      return { handled: true, reply: bridge.cancel(peerKey) }

    case '/approve':
    case '/deny': {
      if (gate === undefined) return { handled: true, reply: '当前没有审批能力（卡片门未启用）。' }
      const pending = gate.pendingFor(peerKey)
      const target = arg === '' ? undefined : arg
      const result = await gate.answerFromText(peerKey, target === undefined
        ? (name.toLowerCase() === '/approve' ? '1' : '2')
        : `${name.toLowerCase()} ${target}`)
      return { handled: true, reply: result.reply ?? '（无输出）' }
    }

    default:
      return { handled: false }
  }
}

export { HELP }
