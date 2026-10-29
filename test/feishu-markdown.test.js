import assert from 'node:assert/strict'
import test from 'node:test'

import { convertTables, normalizeCard, normalizeCardMarkdown } from '../src/adapters/feishu.js'

test('标题：# / ## 都变成粗体（飞书卡片不认 # 语法）', () => {
  assert.equal(normalizeCardMarkdown('# 一级'), '**一级**')
  assert.equal(normalizeCardMarkdown('## 目录（项目）'), '**目录（项目）**')
  assert.equal(normalizeCardMarkdown('### 更深 ###'), '**更深 ###**')
})

test('标题：行内 # 不受影响（不是行首）', () => {
  assert.equal(normalizeCardMarkdown('这里提到 C# 语言'), '这里提到 C# 语言')
  assert.equal(normalizeCardMarkdown('```\n## 代码里的注释\n```'), '```\n## 代码里的注释\n```')
})

test('表格：折成「· **首列** — 其余列」的列表，并丢掉对齐行', () => {
  const input = [
    '| 目录 | 规模 | 是什么 |',
    '|---|---|---|',
    '| `a` | 1 MB | 甲 |',
    '| `b` | 2 MB | 乙 |',
  ].join('\n')
  assert.equal(
    normalizeCardMarkdown(input),
    ['· **`a`** — 1 MB — 甲', '· **`b`** — 2 MB — 乙'].join('\n'),
  )
})

test('表格：只有表头时退化成一行粗体', () => {
  assert.equal(convertTables('| 甲 | 乙 |\n|---|---|'), '**甲 · 乙**')
})

test('表格：普通文本与表格混排时，非表格部分原样保留', () => {
  const output = normalizeCardMarkdown([
    '前言',
    '| k | v |',
    '|---|---|',
    '| a | 1 |',
    '',
    '后记',
  ].join('\n'))
  assert.equal(output, ['前言', '· **a** — 1', '', '后记'].join('\n'))
})

test('代码块里的竖线不会被误判成表格', () => {
  const code = '```bash\nls | grep x\n```'
  assert.equal(normalizeCardMarkdown(code), code)
})

test('normalizeCard：只改 markdown 元素，并且不改调用方的对象', () => {
  const card = {
    header: { title: { content: '## 不要动标题' } },
    elements: [
      { tag: 'markdown', content: '## 正文' },
      { tag: 'hr' },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '## 注' }] },
    ],
  }
  const normalized = normalizeCard(card)
  assert.equal(normalized.elements[0].content, '**正文**')
  assert.equal(normalized.elements[2].elements[0].content, '## 注', 'note 里的纯文本不该被改')
  assert.equal(card.elements[0].content, '## 正文', '原对象不能被就地修改')
  assert.equal(normalized.elements[1].tag, 'hr')
})

test('normalizeCard 对异常输入不抛错', () => {
  assert.equal(normalizeCard(undefined), undefined)
  assert.deepEqual(normalizeCard({}), {})
  assert.deepEqual(normalizeCard({ elements: [] }), { elements: [] })
})
