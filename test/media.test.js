import assert from 'node:assert/strict'
import test from 'node:test'

import { buildPromptParts, describeMessage, sniffImageMime } from '../src/media.js'
import { parseMessage, shouldHandleChat } from '../src/adapters/feishu.js'

const noopLog = { warn() {}, info() {}, error() {} }

/** 最小可用的 attachments 替身，行为和真宿主的准入一致。 */
function fakeAttachments({ failAdmit = false, failSave = false } = {}) {
  return {
    async admitPromptContent(content) {
      if (failAdmit) throw new Error('图片太大了')
      return content.map((part, index) => {
        if (part.type === 'text') return { type: 'text', text: part.text }
        if (part.type === 'file') return { type: 'file', attachment: part.attachment }
        return { type: 'image', attachment: { id: `att-${index}`, mediaType: part.mediaType } }
      })
    },
    async saveFile({ data, name }) {
      if (failSave) throw new Error('磁盘满了')
      return { id: `file-${name ?? 'unnamed'}`, size: data?.byteLength ?? 0 }
    },
  }
}

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])

test('sniffImageMime 认 png/jpeg/gif/webp，认不出按 jpeg', () => {
  assert.equal(sniffImageMime(png), 'image/png')
  assert.equal(sniffImageMime(jpeg), 'image/jpeg')
  assert.equal(sniffImageMime(Buffer.from('GIF89a......')), 'image/gif')
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP')])
  assert.equal(sniffImageMime(webp), 'image/webp')
  assert.equal(sniffImageMime(Buffer.from([0, 1, 2, 3])), 'image/jpeg')
})

test('describeMessage 给媒体消息一个能当标题的名字', () => {
  assert.equal(describeMessage({ text: ' 你好 ' }), '你好')
  assert.equal(describeMessage({ text: '', images: [{}] }), '［图片］')
  assert.equal(describeMessage({ text: '', images: [{}, {}] }), '［2 张图片］')
  assert.equal(describeMessage({ text: '', audio: {} }), '［语音］')
  assert.equal(describeMessage({ text: '', files: [{ name: 'a.pdf' }] }), '［文件］a.pdf')
})

test('纯文字消息不碰附件服务', async () => {
  const { parts, notes } = await buildPromptParts({
    message: { text: '你好' },
    attachments: fakeAttachments(),
    limits: {},
    log: noopLog,
  })
  assert.deepEqual(parts, [{ type: 'text', text: '你好' }])
  assert.deepEqual(notes, [])
})

test('图片：文字 + 图片一起准入，图片变成 durable ref', async () => {
  const { parts, title } = await buildPromptParts({
    message: { text: '看看这张', images: [{ mediaType: 'image/png', data: png.toString('base64') }] },
    attachments: fakeAttachments(),
    limits: {},
    log: noopLog,
  })
  assert.equal(parts.length, 2)
  assert.deepEqual(parts[0], { type: 'text', text: '看看这张' })
  assert.equal(parts[1].type, 'image')
  assert.equal(parts[1].attachment.id, 'att-1')
  assert.equal(title, '看看这张')
})

test('图片：宿主没有 attachments 时降级成文字说明，不丢消息', async () => {
  const { parts, notes } = await buildPromptParts({
    message: { images: [{ mediaType: 'image/png', data: png.toString('base64') }] },
    attachments: undefined,
    limits: {},
    log: noopLog,
  })
  assert.equal(notes.length, 1)
  assert.match(JSON.stringify(parts), /没有附件服务/)
  assert.equal(parts.some((part) => part.type === 'image'), false)
})

test('图片：准入被拒（太大/格式不支持）也要给出原因', async () => {
  const { parts, notes } = await buildPromptParts({
    message: { text: '看图', images: [{ mediaType: 'image/png', data: png.toString('base64') }] },
    attachments: fakeAttachments({ failAdmit: true }),
    limits: {},
    log: noopLog,
  })
  assert.ok(notes.some((note) => note.includes('图片太大')))
  assert.equal(parts[0].text, '看图')
  assert.match(parts.at(-1).text, /被宿主拒绝/)
})

test('图片：超过本地上限的图片直接跳过并提示', async () => {
  const big = Buffer.alloc(2048, 1).toString('base64')
  const { parts, notes } = await buildPromptParts({
    message: { images: [{ mediaType: 'image/png', data: big }] },
    attachments: fakeAttachments(),
    limits: { imageMaxBytes: 100 },
    log: noopLog,
  })
  assert.ok(notes.some((note) => note.includes('超过')))
  assert.equal(parts.some((part) => part.type === 'image'), false)
})

test('文件：先 saveFile 再作为 file 块交给 agent', async () => {
  const { parts } = await buildPromptParts({
    message: { text: '看这个文件', files: [{ data: Buffer.from('hi'), name: 'a.txt' }] },
    attachments: fakeAttachments(),
    limits: {},
    log: noopLog,
  })
  const file = parts.find((part) => part.type === 'file')
  assert.ok(file !== undefined)
  assert.equal(file.attachment.id, 'file-a.txt')
})

test('文件：保存失败时说明原因而不是丢掉整条消息', async () => {
  const { parts, notes } = await buildPromptParts({
    message: { text: '看这个文件', files: [{ data: Buffer.from('hi'), name: 'a.txt' }] },
    attachments: fakeAttachments({ failSave: true }),
    limits: {},
    log: noopLog,
  })
  assert.ok(notes.some((note) => note.includes('保存失败')))
  assert.equal(parts.some((part) => part.type === 'text' && part.text === '看这个文件'), true)
})

test('语音：没有转写服务时存成附件 + 明确告知 agent', async () => {
  const { parts, notes } = await buildPromptParts({
    message: { audio: { data: Buffer.from('ogg'), format: 'ogg', durationMs: 4200 } },
    attachments: fakeAttachments(),
    speech: undefined,
    limits: {},
    log: noopLog,
  })
  assert.deepEqual(notes, [])
  assert.equal(parts.some((part) => part.type === 'file'), true)
  const note = parts.find((part) => part.type === 'text')
  assert.match(note.text, /语音/)
  assert.match(note.text, /约 4 秒/)
})

test('语音：有转写服务时直接用文字，不留附件', async () => {
  const speech = {
    resolve: () => ({ provider: { info: { id: 'fake' } }, audio: {} }),
    transcribe: async () => ({ text: '帮我看下这个 bug' }),
  }
  const { parts } = await buildPromptParts({
    message: { audio: { data: Buffer.from('ogg'), format: 'ogg' } },
    attachments: fakeAttachments(),
    speech,
    limits: {},
    log: noopLog,
  })
  assert.equal(parts.length, 1)
  assert.equal(parts[0].type, 'text')
  assert.match(parts[0].text, /语音转写.*帮我看下这个 bug/)
})

test('语音：转写抛错时降级为附件，不阻塞消息', async () => {
  const speech = {
    resolve: () => ({}),
    transcribe: async () => { throw new Error('模型没加载') },
  }
  const { parts } = await buildPromptParts({
    message: { audio: { data: Buffer.from('ogg'), format: 'ogg' } },
    attachments: fakeAttachments(),
    speech,
    limits: {},
    log: noopLog,
  })
  assert.equal(parts.some((part) => part.type === 'file'), true)
})

test('飞书：parseMessage 覆盖文本/富文本/图片/语音/文件/视频', () => {
  assert.deepEqual(parseMessage({ message_type: 'text', content: '{"text":"hi"}' }), { kind: 'text', text: 'hi' })

  const post = parseMessage({
    message_type: 'post',
    content: JSON.stringify({ content: [[{ tag: 'text', text: '看这张' }, { tag: 'img', image_key: 'img_1' }]] }),
  })
  assert.equal(post.kind, 'post')
  assert.equal(post.text, '看这张')
  assert.deepEqual(post.imageKeys, ['img_1'])

  assert.deepEqual(parseMessage({ message_type: 'image', content: '{"image_key":"img_2"}' }), { kind: 'image', imageKey: 'img_2' })
  assert.equal(parseMessage({ message_type: 'audio', content: '{"file_key":"f1","duration":3000}' }).kind, 'audio')
  assert.equal(parseMessage({ message_type: 'audio', content: '{"file_key":"f1","duration":3000}' }).durationMs, 3000)
  assert.deepEqual(parseMessage({ message_type: 'file', content: '{"file_key":"f2","file_name":"a.pdf"}' }), { kind: 'file', fileKey: 'f2', fileName: 'a.pdf' })
  assert.equal(parseMessage({ message_type: 'media', content: '{"file_key":"f3"}' }).fileName, 'video.mp4')
  assert.equal(parseMessage({ message_type: 'sticker', content: '{}' }).kind, 'unsupported')
  assert.equal(parseMessage({ message_type: 'text', content: 'not json' }).kind, 'unsupported')
})

test('飞书：群聊里 @ 了机器人就放行（哪怕正文是空的图片消息）', () => {
  const config = { allowedChatTypes: ['p2p', 'group'], groupMentionOnly: true }
  assert.equal(shouldHandleChat({ chatType: 'group', config, text: '', mentioned: true }), true)
  assert.equal(shouldHandleChat({ chatType: 'group', config, text: '', mentioned: false }), false)
  assert.equal(shouldHandleChat({ chatType: 'group', config, text: '助手 帮我跑个测试', mentioned: false }), true)
  assert.equal(shouldHandleChat({ chatType: 'group', config, text: '大家早上好', mentioned: false }), false)
  assert.equal(shouldHandleChat({ chatType: 'channel', config, text: 'x', mentioned: true }), false)
})
