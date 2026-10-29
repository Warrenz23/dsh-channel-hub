/**
 * 媒体入站：把 IM 传来的图片/语音/文件变成 agent 能读的 prompt 内容块。
 *
 * DSH 的约束（照源码确认）：
 *  - `ctx.attachments.admitPromptContent(parts)` 是唯一入口；image 部分要
 *    **canonical base64**（`{type:'image', mediaType, data}`），返回的 image 会被
 *    换成 durable 的 attachment ref；file 部分必须**先** `saveFile()` 拿到 ref。
 *  - 裸 base64 进不了消息，所以"转成 ref"这一步不能省。
 *  - `attachments` 是可选的宿主能力，没挂的时候必须降级成文字说明，而不是丢消息。
 *
 * 语音两条路：宿主挂了 `speechToText` 就转写成文字；没挂就把音频存成附件并告诉
 * agent "这是用户发来的语音" —— 让 agent 自己决定能不能处理，而不是假装听懂了。
 */
import { statSync } from 'node:fs'

/** 从二进制的头几个字节判断图片类型（飞书不告诉我们 mime）。 */
export function sniffImageMime(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif'
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return 'image/jpeg'
}

/** 标题用的短描述：没有文字时，图片/语音也要能当会话标题。 */
export function describeMessage({ text, images, audio, files }) {
  const trimmed = String(text ?? '').trim()
  if (trimmed !== '') return trimmed
  if (images?.length > 0) return images.length === 1 ? '［图片］' : `［${images.length} 张图片］`
  if (audio !== undefined) return '［语音］'
  if (files?.length > 0) return `［文件］${files[0].name ?? ''}`
  return '［空消息］'
}

/**
 * 把归一化后的入站消息编译成 prompt parts。
 *
 * @param {object} input
 * @param {{text?: string, images?: Array<{mediaType: string, data: string}>, files?: Array<{data: Uint8Array, name?: string}>,
 *   audio?: {data: Uint8Array, format?: string, durationMs?: number}}} input.message
 * @param {any} [input.attachments]  `ctx.attachments`
 * @param {any} [input.speech]       `ctx.speechToText`
 * @param {{images?: boolean, files?: boolean, audio?: boolean, imageMaxBytes?: number}} [input.limits]
 * @param {any} [input.log]
 * @returns {Promise<{parts: object[], notes: string[], title: string}>}
 */
export async function buildPromptParts({ message, attachments, speech, limits = {}, log }) {
  const notes = []
  const allowImages = limits.images !== false
  const allowFiles = limits.files !== false
  const allowAudio = limits.audio !== false
  const maxImageBytes = limits.imageMaxBytes ?? 10 * 1024 * 1024

  /** @type {object[]} */
  const raw = []
  const text = String(message.text ?? '').trim()
  if (text !== '') raw.push({ type: 'text', text })

  // 图片：先过大小闸，再交给宿主做校验/归一化/落盘。
  if (allowImages && Array.isArray(message.images) && message.images.length > 0) {
    for (const image of message.images) {
      const bytes = Math.floor((image.data?.length ?? 0) * 0.75)
      if (bytes > maxImageBytes) {
        notes.push(`有一张图片超过 ${Math.round(maxImageBytes / 1024 / 1024)}MB，已跳过`)
        continue
      }
      raw.push({ type: 'image', mediaType: image.mediaType, data: image.data, ...(image.name === undefined ? {} : { name: image.name }) })
    }
  } else if (!allowImages && message.images?.length > 0) {
    notes.push('这个通道关掉了图片转发，图片没有送给 agent')
  }

  // 文件：必须先 saveFile 拿 durable ref，才能作为 file 块进消息。
  if (allowFiles && Array.isArray(message.files)) {
    for (const file of message.files) {
      if (attachments?.saveFile === undefined) {
        notes.push(`文件 ${file.name ?? ''} 没能转交（宿主没有 attachments 服务）`)
        continue
      }
      try {
        const ref = await attachments.saveFile({ data: file.data, ...(file.name === undefined ? {} : { name: file.name }) })
        raw.push({ type: 'file', attachment: ref })
      } catch (error) {
        log?.warn(`保存附件失败：${String(error)}`)
        notes.push(`文件 ${file.name ?? ''} 保存失败`)
      }
    }
  }

  // 语音：优先转写；没有转写能力就存成附件 + 明确告知。
  if (allowAudio && message.audio !== undefined) {
    const transcript = await transcribe({ audio: message.audio, speech, log })
    if (transcript !== undefined && transcript.trim() !== '') {
      raw.push({ type: 'text', text: `（语音转写）${transcript.trim()}` })
    } else {
      const seconds = message.audio.durationMs === undefined ? '' : `（约 ${Math.round(message.audio.durationMs / 1000)} 秒）`
      if (attachments?.saveFile !== undefined) {
        try {
          const ref = await attachments.saveFile({ data: message.audio.data, name: `voice${message.audio.format === undefined ? '' : `.${message.audio.format}`}` })
          raw.push({ type: 'file', attachment: ref })
          raw.push({ type: 'text', text: `用户发来一段语音${seconds}，当前没有可用的语音转写服务，音频已作为附件：如果读不了，请让用户改发文字。` })
        } catch (error) {
          log?.warn(`保存语音失败：${String(error)}`)
          raw.push({ type: 'text', text: `用户发来一段语音${seconds}，但音频既没能转写也没能保存，请让用户改发文字。` })
        }
      } else {
        raw.push({ type: 'text', text: `用户发来一段语音${seconds}，当前既没有语音转写服务也没有附件存储，请让用户改发文字。` })
      }
    }
  }

  if (raw.length === 0) {
    raw.push({ type: 'text', text: '（这条消息里没有可读的文字或媒体）' })
  }

  // 图片与文件要过一次宿主准入；没挂 attachments 就把图片降级成文字说明。
  const hasBinary = raw.some((part) => part.type === 'image')
  if (!hasBinary) return { parts: raw, notes, title: describeMessage(message) }
  if (attachments?.admitPromptContent === undefined) {
    const stripped = raw.filter((part) => part.type !== 'image')
    stripped.push({ type: 'text', text: '（用户发了图片，但宿主没有附件服务，图片内容无法读取）' })
    notes.push('宿主没有 attachments 服务，图片没有转交')
    return { parts: stripped, notes, title: describeMessage(message) }
  }
  try {
    const admitted = await attachments.admitPromptContent(raw)
    return { parts: admitted, notes, title: describeMessage(message) }
  } catch (error) {
    log?.warn(`图片准入失败：${String(error)}`)
    notes.push(`图片没能转交：${String(error?.message ?? error)}`)
    const stripped = raw.filter((part) => part.type !== 'image')
    stripped.push({ type: 'text', text: '（用户发的图片被宿主拒绝了，可能太大或格式不支持）' })
    return { parts: stripped, notes, title: describeMessage(message) }
  }
}

/**
 * 试一次语音转写。宿主没有这个服务、或形状对不上，都返回 undefined —— 
 * 这是"尽力而为"，不是必需能力。
 */
async function transcribe({ audio, speech, log }) {
  if (speech?.resolve === undefined || speech?.transcribe === undefined) return undefined
  try {
    const spec = speech.resolve({ audio: { data: audio.data, ...(audio.format === undefined ? {} : { format: audio.format }) } })
    const result = await speech.transcribe(spec, AbortSignal.timeout(60_000))
    // 转写结果在不同 provider 下可能是字符串或 { text }，两种都接受。
    if (typeof result === 'string') return result
    if (typeof result?.text === 'string') return result.text
    if (typeof result?.transcript === 'string') return result.transcript
    log?.warn('语音转写返回了没见过的结构，已忽略')
    return undefined
  } catch (error) {
    log?.warn(`语音转写失败（降级为附件）：${String(error)}`)
    return undefined
  }
}

/** 文件的字节数（测试与限额用）。 */
export function byteLength(input) {
  if (input === undefined || input === null) return 0
  if (typeof input.byteLength === 'number') return input.byteLength
  if (typeof input.length === 'number') return input.length
  try {
    return statSync(input).size
  } catch {
    return 0
  }
}
