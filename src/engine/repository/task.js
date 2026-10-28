import { db } from './db.js'
import { requireSession } from './session.js'
import { AppError } from '../common/errors.js'
import { trimText } from '../common/json.js'

/** 任务状态：queued（排队） / running（执行中） / done（已完成） / cancelled（已取消） */
const TASK_STORE = 'message_tasks'

function nowIso() {
  return new Date().toISOString()
}

export async function enqueueTask(sessionId, input = {}) {
  const session = await requireSession(sessionId)
  const content = trimText(input.content)
  const attachmentIds = (Array.isArray(input.attachment_ids) ? input.attachment_ids : [])
    .map(Number)
    .filter((id) => Number.isFinite(id))
  if (!content && !attachmentIds.length && !(Array.isArray(input.attachments) && input.attachments.length)) {
    throw new AppError('消息内容不能为空', 'MESSAGE_EMPTY')
  }
  // 附件：优先用内联对象（含 data_url），没有则退回 attachment_ids
  const attachments = Array.isArray(input.attachments)
    ? input.attachments.filter((a) => a && (a.data_url || a.url))
    : []

  const record = {
    session_id: session.id,
    content,
    attachment_ids: attachmentIds,
    /* 内联附件：浏览器版没有后端上传通道，图片以 data_url 直接随任务保存，
     * 否则「发送时的附件」在队列重放（刷新后继续执行）时会丢失 */
    attachments,
    turn_id: trimText(input.turn_id) || null,
    status: 'queued',
    created_at: nowIso(),
    updated_at: nowIso()
  }
  const id = await db.add(TASK_STORE, record)
  return { ...record, id }
}

export async function listSessionTasks(sessionId) {
  const session = await requireSession(sessionId)
  const rows = await db.allByIndex(TASK_STORE, 'session_id', session.id)
  return rows
    .filter((row) => row.status === 'queued' || row.status === 'running')
    .sort((a, b) => a.id - b.id)
}

export async function getTask(taskId) {
  return db.get(TASK_STORE, Number(taskId))
}

export async function updateTask(taskId, patch = {}) {
  const current = await getTask(taskId)
  if (!current) return null
  const next = { ...current, ...patch, updated_at: nowIso() }
  await db.put(TASK_STORE, next)
  return next
}

export async function cancelTask(sessionId, taskId) {
  const session = await requireSession(sessionId)
  const task = await getTask(taskId)
  if (!task || task.session_id !== session.id) return false
  await db.remove(TASK_STORE, task.id)
  return true
}

/** 取队首任务并标记为执行中；没有排队任务时返回 null */
export async function claimNextTask(sessionId) {
  const session = await requireSession(sessionId)
  const rows = (await db.allByIndex(TASK_STORE, 'session_id', session.id))
    .filter((row) => row.status === 'queued')
    .sort((a, b) => a.id - b.id)
  const first = rows[0]
  if (!first) return null
  return updateTask(first.id, { status: 'running' })
}

export async function finishTask(taskId) {
  if (!taskId) return null
  return updateTask(taskId, { status: 'done' })
}

export async function clearSessionTasks(sessionId) {
  const session = await requireSession(sessionId)
  const rows = await db.allByIndex(TASK_STORE, 'session_id', session.id)
  if (!rows.length) return 0
  await db.bulkRemove(TASK_STORE, rows.map((row) => row.id))
  return rows.length
}

export function normalizeTask(task) {
  if (!task) return null
  return {
    id: task.id,
    session_id: task.session_id,
    content: task.content || '',
    attachment_ids: Array.isArray(task.attachment_ids) ? task.attachment_ids : [],
    attachments: Array.isArray(task.attachments) ? task.attachments : [],
    turn_id: task.turn_id || null,
    status: task.status || 'queued',
    created_at: task.created_at,
    updated_at: task.updated_at
  }
}
