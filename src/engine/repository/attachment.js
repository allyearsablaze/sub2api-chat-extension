import { db } from './db.js'
import { requireSession } from './session.js'
import { AppError } from '../common/errors.js'
import { toNumberOrNull, trimText } from '../common/json.js'

/** 单个附件上限：10 MiB（base64 后约 13.3 MiB，仍是 IndexedDB 能稳定处理的量级） */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024
/**
 * 附件数量上限已取消。
 *
 * 之前限制「草稿 8 个 / 单条消息 8 个」，但草稿附件是持久化在 IndexedDB 的、
 * 界面却只存在内存里，刷新后看不见却仍占配额，用户会遇到「明明没有附件却提示超出限制」。
 * 现在只保留单文件大小限制，附件个数不再设限。
 */
export const ATTACHMENT_MAX_COUNT = Number.POSITIVE_INFINITY

const DATA_URL_RE = /^data:([^;,]+)?(;base64)?,/i

function parseDataUrl(dataUrl) {
  const raw = trimText(dataUrl)
  if (!raw) return null
  if (!DATA_URL_RE.test(raw)) return null
  const comma = raw.indexOf(',')
  if (comma < 0) return null
  return {
    head: raw.slice(0, comma),
    payload: raw.slice(comma + 1)
  }
}

function estimateBytes(parsed) {
  if (!parsed) return 0
  if (/;base64$/i.test(parsed.head)) {
    const padding = (parsed.payload.match(/=+$/) || [''])[0].length
    return Math.max(0, Math.floor((parsed.payload.length * 3) / 4) - padding)
  }
  return parsed.payload.length
}

/** 把 data URL 拆成基段，供模型请求按协议重组成 image block */
export function attachmentPayload(attachment) {
  const parsed = parseDataUrl(attachment?.data_url)
  if (!parsed) return null
  const base64 = /;base64$/i.test(parsed.head)
  return {
    media_type: String(attachment?.content_type || '').toLowerCase() || 'application/octet-stream',
    base64,
    data: parsed.payload
  }
}

export function isImageAttachment(attachment) {
  const type = String(attachment?.content_type || '').toLowerCase()
  return type.startsWith('image/') && !!parseDataUrl(attachment?.data_url)
}

/** 附件对模型的文本描述：非图片附件只透出元信息，不做内容解析 */
export function attachmentLabel(attachment) {
  const name = attachment?.file_name || '附件'
  const type = attachment?.content_type || '未知类型'
  const size = Number(attachment?.size)
  const sizeText = Number.isFinite(size) && size > 0 ? `${Math.round(size / 1024)} KB` : '未知大小'
  return `[附件] ${name}（${type}，${sizeText}）`
}

export async function createAttachment(sessionId, input = {}) {
  const session = await requireSession(sessionId)
  const dataUrl = trimText(input.data_url || input.dataUrl)
  const parsed = parseDataUrl(dataUrl)
  if (!parsed) throw new AppError('附件内容必须是 data URL', 'ATTACHMENT_INVALID')
  const size = toNumberOrNull(input.size) ?? estimateBytes(parsed)
  if (size > ATTACHMENT_MAX_BYTES) {
    throw new AppError(`附件不能超过 ${Math.round(ATTACHMENT_MAX_BYTES / 1024 / 1024)} MB`, 'ATTACHMENT_TOO_LARGE')
  }
  const record = {
    session_id: session.id,
    file_name: trimText(input.file_name || input.name) || '附件',
    content_type: trimText(input.content_type || input.type) || parsed.head.replace(/^data:/i, '').split(';')[0] || 'application/octet-stream',
    size: Math.max(0, size),
    data_url: dataUrl,
    turn_id: null,
    created_at: new Date().toISOString()
  }
  const id = await db.add('attachments', record)
  return { ...record, id }
}

/**
 * 给附件打上归属标记，释放草稿配额。
 *
 * turn_id 字段的语义：
 *   null           草稿：还挂在主输入区待发送，占草稿配额
 *   turn:<id>      已随某一轮消息发送
 *   queue:<taskId> 随排队消息入队
 *   append:<id>    随追加内容入队
 *   dialog:<key>   在队列/追加弹层里上传（还没提交）
 *
 * 之前只有「已发送」会打标记，排队与追加的附件一直算草稿，
 * 反复使用后草稿配额（8 个）被占满，弹层里再粘贴就报「草稿附件最多 8 个」。
 */
export async function markAttachmentsOwned(sessionId, attachmentIds = [], owner = '') {
  if (!owner || !attachmentIds.length) return 0
  const session = await requireSession(sessionId)
  let count = 0
  for (const id of attachmentIds) {
    const row = await db.get('attachments', Number(id))
    if (!row || row.session_id !== session.id) continue
    await db.put('attachments', { ...row, turn_id: owner })
    count += 1
  }
  return count
}

/** 消息发送后给附件打上轮次标记，草稿配额随之释放 */
export async function markAttachmentsUsed(sessionId, attachmentIds = [], turnId = null) {
  if (!turnId || !attachmentIds.length) return 0
  return markAttachmentsOwned(sessionId, attachmentIds, `turn:${turnId}`)
}

export async function listSessionAttachments(sessionId) {
  const session = await requireSession(sessionId)
  const rows = await db.allByIndex('attachments', 'session_id', session.id)
  return rows.sort((a, b) => a.id - b.id)
}

export async function getAttachment(sessionId, attachmentId) {
  const session = await requireSession(sessionId)
  const row = await db.get('attachments', Number(attachmentId))
  if (!row || row.session_id !== session.id) return null
  return row
}

export async function removeAttachment(sessionId, attachmentId) {
  const row = await getAttachment(sessionId, attachmentId)
  if (!row) return false
  await db.remove('attachments', row.id)
  return true
}

export async function removeSessionAttachments(sessionId) {
  const rows = await listSessionAttachments(sessionId)
  if (!rows.length) return 0
  await db.bulkRemove('attachments', rows.map((row) => row.id))
  return rows.length
}

/** 把消息里的附件 id 换成轻量元信息，供事件 context 落库 */
export async function resolveAttachments(sessionId, attachmentIds = []) {
  const ids = [...new Set((Array.isArray(attachmentIds) ? attachmentIds : []).map(Number).filter((id) => Number.isFinite(id)))]
  if (!ids.length) return []
  const rows = await Promise.all(ids.map((id) => getAttachment(sessionId, id)))
  const missing = rows.findIndex((row) => !row)
  if (missing >= 0) throw new AppError('附件不存在或不属于当前会话', 'ATTACHMENT_NOT_FOUND')
  /* 附件个数不再设限，只保留单文件大小约束 */
  return rows
}

/** 事件里保存的附件元信息（不含 data_url，避免事件表膨胀） */
export function attachmentMeta(rows = []) {
  return rows.map((row) => ({
    id: row.id,
    file_name: row.file_name,
    content_type: row.content_type,
    size: row.size
  }))
}

/** 把附件元信息还原成可用于请求的块（图片走 data URL，其他文件只给描述） */
export async function hydrateAttachments(sessionId, metas = []) {
  const out = []
  for (const meta of metas) {
    const row = await getAttachment(sessionId, meta.id)
    if (!row) {
      out.push({ meta, image: null })
      continue
    }
    out.push({ meta: { ...meta, id: row.id }, image: isImageAttachment(row) ? row : null })
  }
  return out
}
