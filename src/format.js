/**
 * 呈现层：把 agent 的输出变成 IM 能看的东西。
 *
 * 设计取舍：
 *  - **富文本走卡片**。飞书的 text 消息会把 markdown 原样吐出来（`**粗体**`
 *    带星号），而卡片里的 markdown 元素能渲染代码块、列表、加粗。所以默认
 *    用卡片，只有当一整段是纯文本短句时才用 text 消息（更轻、更像聊天）。
 *  - **分段在这里做**。平台单条消息有上限，agent 的回答经常上万字，分段逻辑
 *    必须是纯函数，才能被单测钉住。
 *  - **不在分段处切断代码块**。宁可多带一个 ``` 闭合，也别让用户看到半截代码。
 */

/**
 * 平台单条消息的保守上限。
 *
 * 6400 字符（中文约 19 KB UTF-8）仍在飞书卡片 30 KB 的上限之内 —— 定大一点，
 * 大部分回答就能塞进**一张**卡，不用分段（"续 2/3"本身就是噪音）。
 */
export const DEFAULT_CHUNK_LIMIT = 6400

/**
 * 按行切分长文本，尽量在段落/代码块边界断开。
 *
 * @param {string} text
 * @param {number} [limit]
 * @returns {string[]} 至少一段；空输入返回空数组。
 */
export function chunkText(text, limit = DEFAULT_CHUNK_LIMIT) {
  const source = String(text ?? '')
  if (source.trim() === '') return []
  if (source.length <= limit) return [source]

  const chunks = []
  let buffer = ''
  let openFence = false

  const flush = () => {
    if (buffer === '') return
    chunks.push(openFence ? `${buffer.trimEnd()}\n\`\`\`` : buffer.trimEnd())
    buffer = openFence ? '```\n' : ''
  }

  for (const line of source.split('\n')) {
    const isFence = line.trimStart().startsWith('```')
    // 超长单行（压缩过的 JSON / 长 URL）只能硬切。
    if (line.length > limit) {
      if (buffer !== '') {
        chunks.push(buffer.trimEnd())
        buffer = ''
      }
      for (let i = 0; i < line.length; i += limit) chunks.push(line.slice(i, i + limit))
      continue
    }
    if (buffer.length + line.length + 1 > limit) flush()
    buffer += `${line}\n`
    if (isFence) openFence = !openFence
  }
  if (buffer.trim() !== '' && buffer.trim() !== '```') {
    chunks.push(openFence ? `${buffer.trimEnd()}\n\`\`\`` : buffer.trimEnd())
  }
  return chunks
}

/** 超过 max 就截断并加省略号，用于标题/摘要。 */
export function truncate(text, max = 60) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

/** 去掉 markdown 装饰，留给只认纯文本的通道。 */
export function toPlainText(text) {
  return String(text ?? '')
    .replace(/```[a-zA-Z0-9_-]*\n?/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/^\s*[-*]\s+/gm, '· ')
}

/**
 * 一条消息更适合 text 还是卡片？
 *
 * 纯短句（无代码块、无 markdown 结构）用 text，其余用卡片。
 */
export function preferCard(text) {
  const value = String(text ?? '')
  if (value.length > 240) return true
  return /```|^#{1,6}\s|\*\*|^\s*[-*]\s|^\s*\d+\.\s|^\|/m.test(value)
}

const COLORS = {
  blue: 'blue',
  green: 'green',
  orange: 'orange',
  red: 'red',
  grey: 'grey',
}

/**
 * 构造飞书互动卡片。
 *
 * @param {object} input
 * @param {string} [input.title]
 * @param {'blue'|'green'|'orange'|'red'|'grey'} [input.color]
 * @param {string} input.markdown
 * @param {string} [input.footer]
 * @param {Array<Array<object>>} [input.actions] 每个内层数组是一行按钮
 */
export function buildCard({ title, color = 'blue', markdown, footer, actions }) {
  const card = {
    config: { wide_screen_mode: true, update_multi: true },
    elements: [],
  }
  if (title !== undefined && title !== '') {
    card.header = {
      template: COLORS[color] ?? 'blue',
      title: { tag: 'plain_text', content: truncate(title, 80) },
    }
  }
  const body = String(markdown ?? '')
  if (body.trim() !== '') {
    card.elements.push({ tag: 'markdown', content: body })
  }
  for (const row of actions ?? []) {
    if (row.length === 0) continue
    card.elements.push({
      tag: 'action',
      layout: 'bisected',
      actions: row.map((button) => ({
        tag: 'button',
        text: { tag: 'plain_text', content: button.label },
        type: button.type ?? 'default',
        value: button.value ?? {},
      })),
    })
  }
  if (footer !== undefined && footer !== '') {
    card.elements.push({ tag: 'hr' })
    card.elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: footer }] })
  }
  if (card.elements.length === 0) {
    card.elements.push({ tag: 'markdown', content: '（无内容）' })
  }
  return card
}

/** 运行中的进度卡：标题带转圈，正文是当前状态。 */
export function buildProgressCard({ title, status, detail }) {
  const lines = [`**${status}**`]
  if (detail !== undefined && detail !== '') lines.push(detail)
  return buildCard({ title, color: 'orange', markdown: lines.join('\n\n'), footer: '收到 /stop 可中断本轮' })
}

/** 审批卡：两个按钮，value 里带我们自己的请求 id。 */
export function buildApprovalCard({ id, toolName, reason, sessionLabel, index, total }) {
  const heading = total !== undefined && total > 1 && index !== undefined ? `需要权限确认（${index}/${total}）` : '需要权限确认'
  const lines = [`**工具**：${toolName || '未知工具'}`]
  if (reason !== undefined && reason !== '') lines.push(`**原因**：${reason}`)
  if (sessionLabel !== undefined && sessionLabel !== '') lines.push(`**会话**：${sessionLabel}`)
  lines.push('允许后仅对这一次调用生效。')
  return buildCard({
    title: heading,
    color: 'orange',
    markdown: lines.join('\n'),
    actions: [[
      { label: '✅ 仅这次允许', type: 'primary', value: { hub: 'approve', id } },
      { label: '⛔ 拒绝', type: 'danger', value: { hub: 'deny', id } },
    ]],
    footer: `或在聊天里回复 1（允许）/ 2（拒绝）。请求 ${id}`,
  })
}

/**
 * 提问卡：单题且选项不多时给按钮，否则退回文本编号。
 *
 * @returns {{card: object} | {text: string}}
 */
export function buildQuestionCard({ id, question, header, options, index, total, multiSelect }) {
  const title = total !== undefined && total > 1 && index !== undefined ? `需要你确认（${index}/${total}）` : (header || '需要你确认')
  if (Array.isArray(options) && options.length > 0 && options.length <= 5) {
    const buttons = options.slice(0, 5).map((option) => ({
      label: truncate(option.label ?? String(option), 30),
      type: 'default',
      value: { hub: 'answer', id, choice: option.value ?? option.label ?? option },
    }))
    return { card: buildCard({ title, color: 'blue', markdown: question, actions: [buttons], footer: multiSelect === true ? '可多选：在聊天里回复选项编号，用逗号分隔' : `请求 ${id}` }) }
  }
  const lines = [question]
  if (Array.isArray(options)) {
    lines.push('')
    options.forEach((option, i) => lines.push(`${i + 1}. ${option.label ?? option}`))
  }
  lines.push('', multiSelect === true ? '回复编号（多选用逗号分隔，可加自定义文字）。' : '回复编号，或直接回复你的答案。')
  return { text: lines.join('\n') }
}

/** 把审批/提问的等待状态画成一行摘要，给 /status 用。 */
export function describePendingCards(entries) {
  if (entries.length === 0) return '无待处理卡片'
  return entries.map((entry) => `· ${entry.kind === 'approval' ? '审批' : '提问'} ${entry.id}（${entry.toolName ?? entry.question ?? ''}）`).join('\n')
}
