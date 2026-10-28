import { db } from './db.js'
import { ensure } from '../common/errors.js'
import { nowIso } from '../common/time.js'
import { clone, toNumberOrNull, trimText } from '../common/json.js'
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_HISTORY_MESSAGES,
  defaultExecutionParams,
  defaultHistoryTokenRatio,
  defaultMaxHistoryMessages,
  defaultModalities,
  estimateMessageTokens,
  modelParamsWithDefaults,
  sanitizeExecutionParams
} from '../model/model_params.js'
import { buildUserContent } from '../model/message_content.js'
import { serializeToolResultForContext } from '../model/tool_result_summary.js'
import { deleteImagesBySession, deleteImagesByTurn } from './image_cache.js'

export const EVENT_TYPES = [
  'user_message',
  'append_message',
  'model_reasoning',
  'model_reply',
  'model_retry',
  'tool_call',
  'tool_result',
  'subagent',
  'turn_notice',
  'turn_error',
  'task_failed',
  'model_reply_cancelled'
]

/** 会话模型快照：对话不依赖 Agent，供应商/模型/提示词与参数全部落在快照里 */
export function normalizeModelSnapshot(input) {
  if (!input || typeof input !== 'object') return null
  const kind = trimText(input.provider_kind) || 'openai'
  const api = trimText(input.api) || (kind === 'anthropic' ? 'messages' : 'completions')
  return {
    provider_id: toNumberOrNull(input.provider_id),
    model_id: toNumberOrNull(input.model_id),
    provider_kind: kind,
    provider_label: trimText(input.provider_label),
    model_label: trimText(input.model_label),
    api,
    context_window: toNumberOrNull(input.context_window) ?? DEFAULT_CONTEXT_WINDOW,
    max_history_messages: defaultMaxHistoryMessages(input.max_history_messages),
    history_token_ratio: defaultHistoryTokenRatio(input.history_token_ratio),
    modalities: defaultModalities(input.modalities),
    model_params: modelParamsWithDefaults(kind, api, input.model_params),
    /* 只保存显式设置项；未设置的项在执行时回落到全局设置 */
    execution_params: sanitizeExecutionParams(input.execution_params),
    additional_params:
      input.additional_params && typeof input.additional_params === 'object'
        ? clone(input.additional_params)
        : {}
  }
}

export function emptySessionSnapshot() {
  return normalizeModelSnapshot({
    provider_kind: 'openai',
    api: 'completions',
    context_window: DEFAULT_CONTEXT_WINDOW,
    max_history_messages: DEFAULT_MAX_HISTORY_MESSAGES,
    history_token_ratio: undefined,
    modalities: ['text'],
    model_params: {},
    execution_params: defaultExecutionParams(),
    additional_params: {}
  })
}

export function defaultSessionConfig(input = {}) {
  return {
    /* 兼容旧记录：快照已提升到顶层，这里只保留额外会话配置 */
    pinned: !!input.pinned
  }
}

export function normalizeSession(input = {}) {
  const snapshot =
    normalizeModelSnapshot(input.model_snapshot) ||
    normalizeModelSnapshot(input.config?.model_snapshot) ||
    null
  return {
    id: input.id ?? null,
    session_type: 'common',
    title: trimText(input.title) || '新会话',
    environment_id: toNumberOrNull(input.environment_id),
    provider_id: toNumberOrNull(input.provider_id) ?? snapshot?.provider_id ?? null,
    model_id: toNumberOrNull(input.model_id) ?? snapshot?.model_id ?? null,
    prompt_id: toNumberOrNull(input.prompt_id),
    model_snapshot: snapshot,
    config: defaultSessionConfig(input.config || {}),
    created_at: input.created_at || nowIso(),
    updated_at: nowIso()
  }
}

/**
 * 列出会话。
 * message_count 用它来显示「N 条」并决定是否显示「清空」按钮，
 * 所以这里实时统计一次；会话数量通常不多（几十条），开销可接受。
 */
export async function listSessions() {
  const rows = await db.all('sessions')
  const counts = new Map()
  try {
    const events = await db.all('message_events')
    for (const e of events) {
      const sid = Number(e.session_id)
      if (!Number.isFinite(sid)) continue
      // 只统计对话内容，工具/思考等内部事件不计入「N 条」
      if (e.event_type === 'user_message' || e.event_type === 'model_reply') {
        counts.set(sid, (counts.get(sid) || 0) + 1)
      }
    }
  } catch (_) {
    /* 统计失败不影响列表 */
  }
  return rows
    .map((s) => ({ ...s, message_count: counts.get(Number(s.id)) || 0 }))
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
}

export async function getSession(sessionId) {
  const id = toNumberOrNull(sessionId)
  if (id === null) return null
  return (await db.get('sessions', id)) || null
}

export async function requireSession(sessionId) {
  const session = await getSession(sessionId)
  ensure(session, `会话 #${sessionId} 不存在`, 'SESSION_NOT_FOUND')
  return session
}

export async function createSession(input = {}) {
  const record = normalizeSession(input)
  const created = { ...record }
  delete created.id
  return db.add('sessions', created)
}

export async function updateSession(sessionId, patch = {}) {
  const current = await requireSession(sessionId)
  const next = {
    ...current,
    ...normalizeSession({ ...current, ...patch, id: current.id, created_at: current.created_at }),
    updated_at: nowIso()
  }
  await db.put('sessions', next)
  return next
}

/** 保存会话的模型/参数快照（对话面板的自动保存入口） */
export async function updateSessionSnapshot(sessionId, payload = {}) {
  const current = await requireSession(sessionId)
  const base = current.model_snapshot || {
    provider_id: current.provider_id,
    model_id: current.model_id,
    provider_kind: 'openai',
    api: 'completions'
  }
  const snapshot = normalizeModelSnapshot({
    ...base,
    ...payload,
    /* 局部更新（例如只调执行参数）时不能把已选的供应商/模型抹掉 */
    provider_id: payload.provider_id ?? base.provider_id,
    model_id: payload.model_id ?? base.model_id
  })
  ensure(snapshot, '模型快照无效', 'SESSION_SNAPSHOT_INVALID')
  const next = {
    ...current,
    title: patchTitle(payload.title, current.title),
    environment_id: hasField(payload, 'environment_id')
      ? toNumberOrNull(payload.environment_id)
      : current.environment_id,
    provider_id: snapshot.provider_id,
    model_id: snapshot.model_id,
    /* 提示词必须能显式清空：前端下拉框的「×」会把值置为 undefined，
     * 若按「undefined = 未提供」处理，清除操作会被静默忽略（刷新后又出现）。
     * 这里以「字段是否存在」为准，null 才是明确的清空。 */
    prompt_id: hasField(payload, 'prompt_id') ? toNumberOrNull(payload.prompt_id) : current.prompt_id,
    model_snapshot: snapshot,
    updated_at: nowIso()
  }
  await db.put('sessions', next)
  return next
}

function patchTitle(value, fallback) {
  if (value === undefined) return fallback
  return trimText(value) || fallback
}

/** 判断请求体里是否显式带了这个字段（区别于「字段存在但值为 undefined」） */
function hasField(payload, key) {
  return Object.prototype.hasOwnProperty.call(payload || {}, key)
}

export async function touchSession(sessionId) {
  const current = await getSession(sessionId)
  if (!current) return
  await db.put('sessions', { ...current, updated_at: nowIso() })
}

export async function deleteSession(sessionId) {
  const session = await requireSession(sessionId)
  const events = await db.allByIndex('message_events', 'session_id', session.id)
  await db.bulkRemove('message_events', events.map((event) => event.id))
  /* 连带清图片缓存：否则生成的 base64 会永久留在库里，
   * 会话都删了却还在占空间。 */
  await deleteImagesBySession(session.id).catch(() => {})
  await db.remove('sessions', session.id)
  return true
}

export async function batchDeleteSessions(sessionIds = []) {
  let removed = 0
  for (const id of sessionIds) {
    try {
      await deleteSession(id)
      removed += 1
    } catch (_error) {
      /* 忽略不存在的会话 */
    }
  }
  return removed
}

export async function clearSessionHistory(sessionId) {
  const session = await requireSession(sessionId)
  const events = await db.allByIndex('message_events', 'session_id', session.id)
  await db.bulkRemove('message_events', events.map((event) => event.id))
  // 消息清空后图片也没有引用者了，一并清理
  await deleteImagesBySession(session.id).catch(() => {})
  return events.length
}

export async function appendEvent(sessionId, payload = {}) {
  const session = await requireSession(sessionId)
  const record = {
    parent_event_id: toNumberOrNull(payload.parent_event_id),
    session_id: session.id,
    turn_id: trimText(payload.turn_id) || `t-${Date.now().toString(36)}`,
    status: payload.status || 'completed',
    event_type: payload.event_type || 'turn_notice',
    event_id: trimText(payload.event_id) || String(Date.now()),
    summary: String(payload.summary ?? ''),
    context: payload.context && typeof payload.context === 'object' ? clone(payload.context) : {},
    revision: 1,
    created_at: nowIso(),
    updated_at: nowIso()
  }
  const id = await db.add('message_events', record)
  await touchSession(session.id)
  return { ...record, id }
}

export async function updateEvent(eventId, patch = {}) {
  const current = await db.get('message_events', eventId)
  if (!current) return null
  const next = {
    ...current,
    ...patch,
    context: patch.context && typeof patch.context === 'object' ? clone(patch.context) : current.context,
    revision: (current.revision || 1) + 1,
    updated_at: nowIso()
  }
  await db.put('message_events', next)
  return next
}

export async function listEvents(sessionId, options = {}) {
  const session = await requireSession(sessionId)
  let rows = await db.allByIndex('message_events', 'session_id', session.id)
  rows.sort((a, b) => a.id - b.id)
  if (options.turnId) {
    rows = rows.filter((event) => event.turn_id === options.turnId)
  }
  if (options.afterId) {
    rows = rows.filter((event) => event.id > options.afterId)
  }
  if (options.limit && rows.length > options.limit) {
    rows = rows.slice(rows.length - options.limit)
  }
  return rows
}

/**
 * 组装模型可用的历史消息。
 *
 * 关键点：
 * 1. assistant 的 tool_calls 必须与后续 tool 消息严格配对，否则接口直接 400。
 * 2. tool_call_retention_rounds 控制工具明细保留多少批；被折叠的批次只保留
 *    assistant 的文字结论，工具结果整段删除，既省上下文又不破坏配对关系。
 * 3. tokenBudget + historyTokenRatio 按「字符数 × 比例」估算 token，
 *    从最早的消息开始丢弃，直到装进预算；预算为 0 时不做 token 裁剪。
 */
/**
 * 把事件里保存的附件元信息还原成消息块（图片带上 data URL）。
 * 这里直接读 attachments 表，避免与 attachment.js 形成循环依赖。
 */
async function hydrateEventAttachments(metas = []) {
  const out = []
  for (const meta of Array.isArray(metas) ? metas : []) {
    const id = Number(meta?.id)
    const row = Number.isFinite(id) ? await db.get('attachments', id) : null
    out.push({
      meta,
      image: row && String(row.content_type || '').toLowerCase().startsWith('image/') ? row : null
    })
  }
  return out
}

export async function buildHistoryMessages(sessionId, options = {}) {
  const opts = typeof options === 'number' ? { maxMessages: options } : options || {}
  const maxMessages = toNumberOrNull(opts.maxMessages) ?? 0
  const retention = toNumberOrNull(opts.toolRetentionRounds) ?? 0
  const tokenBudget = toNumberOrNull(opts.tokenBudget) ?? 0
  const ratio = defaultHistoryTokenRatio(opts.historyTokenRatio)

  const events = await listEvents(sessionId)
  let messages = []
  for (const event of events) {
    if (event.event_type === 'user_message' || event.event_type === 'append_message') {
      const raw = event.context?.content
      /* content 可能是：
       *   - 字符串（纯文本）
       *   - parts 数组（多模态：text + image）
       * 直接 String() 会把数组压成 "[object Object]"，图片信息全部丢失，
       * 所以这里要先判断类型。 */
      const isParts = Array.isArray(raw)
      const textContent = isParts
        ? raw.filter((part) => part?.type === 'text').map((part) => part.text).join('\n')
        : String(raw || '')

      const metas = Array.isArray(event.context?.attachments) ? event.context.attachments : []

      if (isParts) {
        // 已经是 parts：原样使用，保留图片块
        const parts = raw.filter((part) => part && (part.type === 'text' || part.type === 'image'))
        const payload = parts.length ? (parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts) : ''
        if (payload) messages.push({ role: 'user', content: payload })
      } else {
        let text = textContent
        // 恢复图片句柄提示：模型需要 ID 才能对这张图执行 edit_image
        const handles = metas.filter((m) => m.image_id && m.is_image)
        if (handles.length) {
          const lines = handles.map((h) => `- ${h.file_name || '上传的图片'}：${h.image_id}`)
          text = `${text}\n\n[用户上传的图片句柄，可直接用于 edit_image 的 image 参数]\n${lines.join('\n')}`.trim()
        }
        const payload = metas.length
          ? buildUserContent(text, await hydrateEventAttachments(metas))
          : text
        if (payload) messages.push({ role: 'user', content: payload })
      }
      continue
    }
    if (event.event_type === 'model_reply') {
      const content = String(event.context?.content || '')
      const toolCalls = Array.isArray(event.context?.tool_calls) ? event.context.tool_calls : []
      if (content || toolCalls.length) {
        messages.push({
          role: 'assistant',
          content,
          tool_calls: toolCalls.map((call) => ({ id: call.id, name: call.name, arguments: call.arguments })),
          reasoning: String(event.context?.reasoning || '')
        })
      }
      continue
    }
    if (event.event_type === 'tool_result') {
      const callId = event.context?.tool_call_id
      if (!callId) continue
      const payload = event.context?.result ?? { ok: event.status !== 'failed' }
      /* 关键：这里必须走摘要，不能直接 JSON.stringify。
       * generate_image 的结果是完整 base64（一张图约 2MB），
       * 原样进历史会让上下文瞬间超限，上游返回
       * 400 "prompt is too long: 2062155 tokens > 1048576 maximum"。
       * 事件里保留完整结果供界面渲染，只对「发给模型的历史」做压缩。 */
      messages.push({
        role: 'tool',
        tool_call_id: callId,
        name: event.context?.name || '',
        content: serializeToolResultForContext(payload)
      })
    }
  }

  if (retention > 0) messages = foldOldToolRounds(messages, retention)

  messages = sanitizeToolPairs(messages)
  if (maxMessages > 0 && messages.length > maxMessages) {
    let start = messages.length - maxMessages
    while (start < messages.length && messages[start].role === 'tool') start += 1
    messages = sanitizeToolPairs(messages.slice(start))
  }
  if (tokenBudget > 0) messages = trimByTokenBudget(messages, tokenBudget, ratio)
  return sanitizeToolPairs(messages)
}

/**
 * 按 token 预算从最早的消息开始丢弃。
 * 至少保留最后一条消息，且不能以 tool 消息开头（否则接口会拒绝）。
 */
export function trimByTokenBudget(messages = [], tokenBudget, ratio) {
  if (!(tokenBudget > 0) || !messages.length) return messages
  let used = 0
  let start = messages.length
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const cost = estimateMessageTokens(messages[index], ratio)
    if (start < messages.length && used + cost > tokenBudget) break
    used += cost
    start = index
  }
  while (start < messages.length && messages[start].role === 'tool') start += 1
  if (start >= messages.length) return messages.slice(-1)
  return start === 0 ? messages : messages.slice(start)
}

/** 只保留最近 N 批工具调用明细，更早的折叠成文字 */
export function foldOldToolRounds(messages, retentionRounds) {
  const withCalls = messages.filter((message) => message.role === 'assistant' && message.tool_calls?.length)
  const drop = withCalls.slice(0, Math.max(0, withCalls.length - retentionRounds))
  if (!drop.length) return messages
  const dropIds = new Set()
  for (const message of drop) {
    for (const call of message.tool_calls) dropIds.add(call.id)
    delete message.tool_calls
    if (!message.content) message.content = '（此前的工具调用明细已折叠）'
  }
  return messages.filter((message) => !(message.role === 'tool' && dropIds.has(message.tool_call_id)))
}

/** 剔除缺少对应 tool 结果的 tool_calls（历史被清理、任务中断时会留下孤立调用） */
export function sanitizeToolPairs(messages = []) {
  const paired = new Set(messages.filter((message) => message.role === 'tool').map((message) => message.tool_call_id))
  return messages
    .map((message) => {
      if (message.role !== 'assistant' || !message.tool_calls?.length) return message
      const kept = message.tool_calls.filter((call) => paired.has(call.id))
      if (kept.length === message.tool_calls.length) return message
      const next = { ...message }
      if (kept.length) next.tool_calls = kept
      else delete next.tool_calls
      return next
    })
    .filter((message) => message.role !== 'assistant' || message.content || message.tool_calls?.length)
}

export async function deleteTurn(sessionId, turnId) {
  const session = await requireSession(sessionId)
  const tid = trimText(turnId)
  const events = await db.allByIndex('message_events', 'session_turn', [session.id, tid])
  await db.bulkRemove('message_events', events.map((event) => event.id))
  // 只清这一轮产生的图，其它轮次的图保留
  await deleteImagesByTurn(session.id, tid).catch(() => {})
  return events.length
}

/** 取最后一条用户消息，用于「重试本轮」 */
export async function lastUserMessage(sessionId) {
  const events = await listEvents(sessionId)
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event.event_type === 'user_message' || event.event_type === 'append_message') {
      return { event, content: String(event.context?.content || '') }
    }
  }
  return null
}
