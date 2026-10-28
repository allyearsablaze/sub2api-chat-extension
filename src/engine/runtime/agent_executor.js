/**
 * 会话回合编排（Web 版）。
 *
 * 相对 SmartPageAgent 原版的改动：
 *   - 去掉 Environment / SubAgent / Skill / MCP 资源解析，本版只用「会话 + 密钥」。
 *   - 工具集合直接由宿主注入的 toolNames 决定（生图工具按平台动态注册）。
 *   - 保留原版核心：事件落库、快照解析、历史裁剪、工具循环、重试、收尾回复。
 */
import { buildSessionPreamble } from './prompt_builder.js'
import { toolRegistry } from './tools/index.js'
import { resolveModelConfig, getPrompt } from '../repository/catalog.js'
import {
  requireSession,
  appendEvent,
  buildHistoryMessages,
  updateSessionSnapshot
} from '../repository/session.js'
import { toEventVo } from '../repository/event_vo.js'
import { getConfigEntries } from '../repository/config.js'
import { runToolLoop } from './tool_loop.js'
import { buildUserContent } from '../model/message_content.js'
import { cacheImage } from '../repository/image_cache.js'
import {
  enqueueTask, listSessionTasks, claimNextTask, finishTask, updateTask, cancelTask
} from '../repository/task.js'
import {
  enqueueAppendItem, claimAppendItems, deliverAppendItems, listSessionAppendItems, removeAppendItem
} from '../repository/append_item.js'
import { resolveAttachments } from '../repository/attachment.js'
import { AppError, isAbortError, toErrorMessage } from '../common/errors.js'
import { createTurnId } from '../common/time.js'
import { toNumberOrNull } from '../common/json.js'

const DEFAULT_MAX_ROUNDS = 8
const DEFAULT_TOOL_TIMEOUT_MS = 60000

function emitSafe(emit, event) {
  try {
    emit?.(event)
  } catch (_error) {
    /* 通道关闭时忽略 */
  }
}

function emitEvent(emit, row) {
  const vo = toEventVo(row)
  if (!vo) return
  emitSafe(emit, { type: 'event', event: vo })
}

/**
 * 执行一个对话回合。
 *
 * @param {object} options
 * @param {string} options.sessionId
 * @param {object} options.input          { text, attachments }
 * @param {Function} options.emit         事件回调 (event) => void
 * @param {AbortSignal} [options.signal]
 * @param {string[]} [options.toolNames]  本次允许的工具名
 * @param {object} [options.toolContext]  工具执行上下文（apiKey / platform / baseUrl）
 * @param {string} [options.persona]
 */
export async function runSessionTurn({
  sessionId,
  input = {},
  emit,
  signal,
  toolNames = [],
  toolContext = {},
  persona = ''
}) {
  const session = await requireSession(sessionId)
  const turnId = createTurnId()

  // ── 1. 解析模型配置（会话快照优先，便于中途切换模型不改历史）──
  const modelConfig = await resolveModelConfig({
    providerId: session.provider_id,
    modelId: session.model_id,
    // 会话快照字段名是 model_snapshot（不是 snapshot）——
    // 传错会导致参数面板保存的 model_params / execution_params 全部失效，
    // 模型只能收到默认参数。
    snapshot: session.model_snapshot,
    api: session.api
  })

  const executionParams = modelConfig.execution_params || {}
  const maxRounds = toNumberOrNull(executionParams.max_tool_call_rounds) ?? DEFAULT_MAX_ROUNDS
  const maxRetries = toNumberOrNull(executionParams.max_retries) ?? 0

  /* 工具超时优先级：
   *   1. 会话级执行参数 tool_timeout_ms（参数面板里可调）
   *   2. 全局设置 tool_timeout_secs（设置弹窗里可调）
   *   3. 内置默认 60 秒
   * 图片类工具另有自己的下限（见 image.js / image_edit.js 的 timeoutMs），
   * 实际取「这里的值」与「工具声明」的较大者。 */
  const globalConfig = await getConfigEntries().catch(() => ({}))
  const globalTimeoutSecs = toNumberOrNull(globalConfig.tool_timeout_secs)
  const toolTimeoutMs =
    toNumberOrNull(executionParams.tool_timeout_ms)
    ?? (globalTimeoutSecs > 0 ? globalTimeoutSecs * 1000 : DEFAULT_TOOL_TIMEOUT_MS)

  const retentionRounds = toNumberOrNull(executionParams.tool_call_retention_rounds) ?? 1

  // ── 2. 写入用户消息事件 ──
  /* 用户上传的图片也要有句柄（img_xxx）：
   * 否则模型看到图却拿不到 ID，后续想 edit_image 只能干瞪眼——
   * 实测模型会回答「我需要一个图片句柄，要么 img_xxx 要么 data URL」。
   * 这里把上传图一并写入 image_cache，并把 ID 拼进文本告知模型。 */
  const rawAttachments = Array.isArray(input?.attachments) ? input.attachments : []
  const uploadedHandles = []
  for (const a of rawAttachments) {
    const isImage = String(a.content_type || '').toLowerCase().startsWith('image/')
    if (!isImage || !a.data_url) continue
    try {
      const row = await cacheImage({
        data_url: a.data_url,
        mime: a.content_type || 'image/png',
        prompt: String(input?.text || '').slice(0, 200),
        action: 'upload',
        session_id: sessionId,
        turn_id: turnId,
      })
      uploadedHandles.push({ id: row.id, name: a.file_name || '' })
    } catch (_) {
      // 缓存失败不影响对话：图仍然会作为 parts 发给模型
    }
  }

  const builtAttachments = rawAttachments.map((a, i) => ({
    meta: { file_name: a.file_name, content_type: a.content_type, size: a.size },
    image: String(a.content_type || '').toLowerCase().startsWith('image/')
      ? { content_type: a.content_type, data_url: a.data_url }
      : null,
  }))

  /* 在文本末尾附上句柄说明，模型才知道可以对哪张图做 edit_image */
  let userText = String(input?.text || '')
  if (uploadedHandles.length) {
    const lines = uploadedHandles.map(
      (h) => `- ${h.name || '上传的图片'}：${h.id}`
    )
    userText = `${userText}\n\n[用户上传的图片句柄，可直接用于 edit_image 的 image 参数]\n${lines.join('\n')}`.trim()
  }
  const userContent = buildUserContent(userText, builtAttachments)

  /* 事件里保存「可直接渲染的附件元信息 + 图片地址」，
   * 时间线据此在用户气泡下方显示图片；content 本身可能是 parts 数组（给模型用） */
  const eventAttachments = rawAttachments.map((a, i) => {
    const isImage = String(a.content_type || '').toLowerCase().startsWith('image/')
    const handle = isImage ? uploadedHandles[i] || uploadedHandles.find((h) => h.name === a.file_name) : null
    return {
      file_name: a.file_name || '',
      content_type: a.content_type || '',
      size: a.size || 0,
      data_url: a.data_url || '',
      is_image: isImage,
      // 图片句柄：历史重新组装时据此恢复「可编辑」提示
      image_id: handle?.id || '',
    }
  })
  const userEvent = await appendEvent(sessionId, {
    turn_id: turnId,
    event_type: 'user_message',
    status: 'completed',
    summary: String(input.text || '').slice(0, 120),
    context: { content: userContent, attachments: eventAttachments }
  })
  emitEvent(emit, userEvent)

  // ── 3. 组装历史与系统提示 ──
  const history = await buildHistoryMessages(sessionId, {
    maxHistoryMessages: modelConfig.max_history_messages,
    contextWindow: modelConfig.context_window,
    historyTokenRatio: modelConfig.history_token_ratio,
    retentionRounds
  })

  // 只保留真正注册过的工具，避免模型调用不存在的函数
  const usableTools = toolNames.filter((name) => toolRegistry.has(name))

  const promptTemplate = session.prompt_id ? await getPrompt(session.prompt_id).catch(() => null) : null
  const personaText = String(persona || promptTemplate?.content || '').trim()

  const system = buildSessionPreamble({
    persona: personaText,
    toolNames: usableTools,
    modelLabel: modelConfig.model?.alias || modelConfig.model?.model_id || '',
    platformLabel: toolContext.platformLabel || ''
  })

  const modelTools = toolRegistry.toModelTools(usableTools)

  // ── 4. 工具执行所需的映射 ──
  const toolMap = new Map()
  const allowedSet = new Set()
  for (const name of usableTools) {
    const tool = toolRegistry.get(name)
    if (!tool) continue
    allowedSet.add(name)
    // tool_loop 期望 toolMap 的值是「带 handler 的工具对象」，不是裸函数
    const settings = await getConfigEntries()
    toolMap.set(name, {
      ...tool,
      handler: (args = {}, ctx = {}) => tool.handler(args, {
        ...toolContext,
        ...ctx,
        signal,
        settings,
        // 归属信息：图片缓存按会话 + 轮次归档，删轮/删会话时据此精确清理
        sessionId,
        turnId,
      })
    })
  }

  // ── 5. 追加消息的取用通道 ──
  // 语义：追加内容先入队（pending），只有当本轮真正要发下一次模型请求时才 claim 出来，
  // 落成 append_message 事件并注入请求。这样「追加出现在事件线」== 「模型真正看到它」。
  const drainAppends = async (currentTurnId) => {
    const claimed = await claimAppendItems(sessionId, currentTurnId)
    if (!claimed.length) return []

    const enriched = []
    for (const item of claimed) {
      const attachments = await resolveAttachments(sessionId, item.attachment_ids || [])
      const content = buildUserContent(item.content || '', attachments.map((row) => ({
        meta: { id: row.id, file_name: row.file_name, content_type: row.content_type, size: row.size },
        image: String(row.content_type || '').toLowerCase().startsWith('image/') ? row : null
      })))
      // 落成事件：此刻起它才出现在对话时间线上
      const event = await appendEvent(sessionId, {
        turn_id: currentTurnId,
        event_type: 'append_message',
        status: 'completed',
        summary: String(item.content || '').slice(0, 120),
        context: { content, append_item_id: item.id }
      })
      emitEvent(emit, event)
      enriched.push({ ...item, content, attachments })
    }
    return enriched
  }

  const onAppendsDelivered = async (items) => {
    const ids = items.map((item) => item.id).filter(Boolean)
    if (ids.length) await deliverAppendItems(ids)
  }

  // ── 6. 跑工具循环 ──
  const result = await runToolLoop({
    sessionId,
    turnId,
    modelConfig,
    system,
    messages: history,
    modelTools,
    toolMap,
    allowedSet,
    maxRounds,
    toolTimeoutMs,
    maxRetries,
    retryBackoffMs: 800,
    drainAppends,
    onAppendsDelivered,
    signal,
    emit,
    ctx: toolContext
  })

  // ── 7. 更新会话快照摘要 ──
  await updateSessionSnapshot(sessionId, {
    last_turn_id: turnId,
    last_event_id: result.lastEventId,
    last_content: String(result.content || '').slice(0, 200)
  }).catch(() => {})

  return {
    turnId,
    content: result.content,
    rounds: result.rounds,
    hitRoundLimit: result.hitRoundLimit,
    lastEventId: result.lastEventId
  }
}

export { isAbortError, toErrorMessage, AppError }
