import { db } from './db.js'
import { requireSession } from './session.js'
import { AppError } from '../common/errors.js'
import { trimText } from '../common/json.js'

/**
 * 追加消息队列（对齐 awake-claw 的 message_append_items 表）。
 *
 * 关键语义：追加内容「入队」与「出现在事件线上」是两件事。
 *   1. 用户点追加 → 写入 pending 项，此时不产生任何事件；
 *   2. 模型循环准备发起下一次请求时 claim 该项 → 落成 append_message 事件并注入请求；
 *   3. 请求成功后标记 delivered。
 * 这样追加内容出现在事件线的时刻，就等于它真正被模型看到的时刻。
 *
 * 状态：pending（排队中） / claimed（已被本轮取用） / delivered（模型已收到）
 */
const APPEND_STORE = 'message_append_items'

function nowIso() {
  return new Date().toISOString()
}

export async function enqueueAppendItem(sessionId, input = {}) {
  const session = await requireSession(sessionId)
  const content = trimText(input.content)
  const attachmentIds = (Array.isArray(input.attachment_ids) ? input.attachment_ids : [])
    .map(Number)
    .filter((id) => Number.isFinite(id))
  if (!content && !attachmentIds.length) throw new AppError('追加内容不能为空', 'MESSAGE_EMPTY')
  const record = {
    session_id: session.id,
    turn_id: trimText(input.turn_id) || null,
    content,
    attachment_ids: attachmentIds,
    status: 'pending',
    message_event_id: null,
    created_at: nowIso(),
    updated_at: nowIso()
  }
  const id = await db.add(APPEND_STORE, record)
  return { ...record, id }
}

/**
 * 取该轮待取用的追加项（按创建顺序），并标记为 claimed。
 *
 * 必须按 turn_id 过滤（对齐 awake 的 claim_message_append_items(session_id, turn_id)）：
 * 追加项是绑定到具体轮次的，不同轮次的追加内容不能互相串。
 */
export async function claimAppendItems(sessionId, turnId = null) {
  const session = await requireSession(sessionId)
  const rows = await db.allByIndex(APPEND_STORE, 'session_id', session.id)
  const target = trimText(turnId)
  const pending = rows
    .filter((row) => row.status === 'pending')
    /* 未绑定轮次的追加项（历史数据）也允许被任意一轮取用 */
    .filter((row) => (target ? !row.turn_id || row.turn_id === target : true))
    .sort((a, b) => a.id - b.id)
  const claimed = []
  for (const row of pending) {
    const next = await updateAppendItem(row.id, { status: 'claimed' })
    claimed.push(next)
  }
  return claimed
}

/** 追加项已被模型真正看到 */
export async function deliverAppendItems(ids = []) {
  let count = 0
  for (const id of ids) {
    const row = await updateAppendItem(id, { status: 'delivered' })
    if (row) count += 1
  }
  return count
}

/** 未被取用的追加项回到 pending（例如本轮提前结束） */
export async function releaseAppendItems(ids = []) {
  let count = 0
  for (const id of ids) {
    const row = await updateAppendItem(id, { status: 'pending' })
    if (row) count += 1
  }
  return count
}

export async function updateAppendItem(id, patch = {}) {
  const row = await db.get(APPEND_STORE, Number(id))
  if (!row) return null
  const next = { ...row, ...patch, updated_at: nowIso() }
  await db.put(APPEND_STORE, next)
  return next
}

export async function listSessionAppendItems(sessionId) {
  const session = await requireSession(sessionId)
  const rows = await db.allByIndex(APPEND_STORE, 'session_id', session.id)
  return rows.sort((a, b) => a.id - b.id)
}

export async function removeAppendItem(sessionId, id) {
  const row = await db.get(APPEND_STORE, Number(id))
  if (!row || row.session_id !== Number(sessionId)) return false
  await db.remove(APPEND_STORE, row.id)
  return true
}

export function normalizeAppendItem(row) {
  if (!row) return null
  return {
    id: row.id,
    session_id: row.session_id,
    turn_id: row.turn_id || null,
    content: row.content || '',
    attachment_ids: Array.isArray(row.attachment_ids) ? row.attachment_ids : [],
    status: row.status || 'pending',
    message_event_id: row.message_event_id ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at
  }
}
