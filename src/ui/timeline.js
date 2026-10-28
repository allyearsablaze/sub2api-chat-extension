/**
 * 会话事件 → 轮次（turn）与渲染条目。
 * 控制台（桌面）与工具栏弹窗（H5）共用，保证两端的事件线结构一致。
 *
 * 轮次被拆成有序的 items 序列（对齐 awake 的 groupConversationTurns）：
 *   user     用户消息或追加消息（右侧气泡）
 *   timeline 一段连续的 AI 事件（左侧轨道）
 * 追加消息不是固定挂在用户消息后面，而是按事件 id 落在它被模型取用的那个位置。
 *
 * items 内的块类型：
 *   reply     模型正文（可带 reasoning / toolCalls）
 *   reasoning 只有思考、没有正文的兜底块
 *   tool      工具调用（含结果）
 *   subagent  子任务
 *   retry     模型请求重试
 *   note      轮次提示
 *   error     失败
 */

function excerpt(text, max = 160) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return `…${flat.slice(-max)}`
}

export function isUserEvent(event) {
  return event?.event_type === 'user_message' || event?.event_type === 'append_message'
}

export function groupTurns(events = []) {
  const map = new Map()
  const list = []
  for (const event of events) {
    const key = event.turn_id ?? 'unknown'
    if (!map.has(key)) {
      const turn = { turnId: key, events: [], user: null, blocks: [], items: [] }
      map.set(key, turn)
      list.push(turn)
    }
    map.get(key).events.push(event)
  }
  for (const turn of list) buildTurnItems(turn)
  return list
}

/**
 * 把一轮事件拆成有序的渲染条目。
 *
 * 关键点（对齐 awake 的 groupConversationTurns）：
 * 用户消息与追加消息都属于「用户气泡」，但它们按事件 id 出现在各自的位置上，
 * 而不是被统一堆到轮次开头。追加消息在模型取用它的那一刻才落库，
 * 所以它自然落在「上一轮 AI 回复」与「下一轮 AI 回复」之间。
 */
function buildTurnItems(turn) {
  const toolIndex = new Map()
  let retrySeq = 0
  /* 思考、工具、回复都是同级的轨道行，按事件顺序平铺，保证图标与正文左对齐 */
  let sawReasoning = false

  const items = []
  const flatBlocks = []
  let segment = null

  const startSegment = () => {
    segment = { kind: 'timeline', blocks: [] }
    items.push(segment)
    return segment
  }
  const ensureSegment = () => (segment || startSegment())
  const pushBlock = (block) => {
    ensureSegment().blocks.push(block)
    flatBlocks.push(block)
    return block
  }

  for (const event of turn.events) {
    if (isUserEvent(event)) {
      /* 用户气泡按事件顺序落位；后面的 AI 事件另起一段轨道 */
      segment = null
      const isAppend = event.event_type === 'append_message'
      items.push({ kind: 'user', event, isAppend })
      if (!isAppend && !turn.user) turn.user = event
      continue
    }
    switch (event.event_type) {
      case 'model_reasoning': {
        const text = event.content || event.summary || ''
        if (text) {
          pushBlock({ kind: 'reasoning', text, summary: excerpt(text), createdAt: event.created_at })
          sawReasoning = true
        }
        break
      }
      case 'model_reply': {
        /* 兼容只有 reply.reasoning、没有单独 model_reasoning 事件的旧数据 */
        if (!sawReasoning && event.reasoning) {
          pushBlock({ kind: 'reasoning', text: event.reasoning, summary: excerpt(event.reasoning), createdAt: event.created_at })
        }
        sawReasoning = false
        if (event.context?.closing) {
          pushBlock({
            kind: 'reply',
            text: event.content,
            closing: true,
            usage: event.usage || null,
            createdAt: event.created_at
          })
          break
        }
        if (event.content || event.tool_calls?.length) {
          pushBlock({
            kind: 'reply',
            text: event.content || '',
            toolCalls: event.tool_calls || [],
            round: event.round,
            usage: event.usage || null,
            createdAt: event.created_at
          })
        }
        break
      }
      case 'tool_call': {
        const block = {
          kind: 'tool',
          id: event.id,
          callId: event.arguments?.id || event.context?.id,
          name: event.name || event.summary,
          arguments: event.arguments?.arguments ?? event.arguments,
          status: event.status,
          result: event.result,
          createdAt: event.created_at
        }
        toolIndex.set(block.callId, block)
        pushBlock(block)
        break
      }
      case 'tool_result': {
        const block = toolIndex.get(event.tool_call_id)
        if (block) {
          block.status = event.status
          block.result = event.result
          block.finishedAt = event.created_at
        } else {
          pushBlock({
            kind: 'tool',
            id: event.id,
            callId: event.tool_call_id,
            name: event.name,
            status: event.status,
            result: event.result,
            createdAt: event.created_at
          })
        }
        break
      }
      case 'model_retry': {
        retrySeq += 1
        pushBlock({
          kind: 'retry',
          id: event.id,
          retryCount: Number(event.retry_count) || retrySeq,
          attempt: event.attempt,
          maxRetries: event.max_retries,
          delayMs: event.delay_ms,
          backoffCapped: !!event.backoff_capped,
          error: event.context?.error,
          attempts: Array.isArray(event.attempts) ? event.attempts : event.context?.attempts || [],
          createdAt: event.created_at,
          updatedAt: event.updated_at
        })
        break
      }
      case 'turn_notice':
        pushBlock({ kind: 'note', text: event.content || event.summary, createdAt: event.created_at })
        break
      case 'task_failed':
      case 'model_reply_cancelled':
      case 'turn_error':
        pushBlock({
          kind: 'error',
          text: event.content || event.summary || '任务失败',
          cancelled: event.status === 'cancelled' || event.event_type === 'model_reply_cancelled',
          createdAt: event.created_at
        })
        break
      default:
        break
    }
  }

  turn.items = items
  turn.blocks = flatBlocks
}

/** 工具块的状态归类，供两端的样式映射使用 */
export function toolStatusKind(status) {
  if (status === 'failed') return 'failed'
  if (status === 'running') return 'processing'
  if (status === 'cancelled') return 'cancelled'
  return 'completed'
}

/* ---------------------------- Token 用量 ---------------------------- */

/** 从 usage 对象里取第一个可用的数值键 */
function numericUsage(usage, ...keys) {
  for (const key of keys) {
    const value = Number(usage?.[key])
    if (Number.isFinite(value)) return value
  }
  return 0
}

/**
 * 汇总一轮的 token 用量。
 *
 * 模型返回的 usage 字段名各家不同（OpenAI 用 prompt_tokens/completion_tokens，
 * Anthropic 用 input_tokens/output_tokens），这里做一次归一。
 * **有服务端返回时一律用服务端的**；只有在完全拿不到 usage 时才按字符数估算，
 * 估算口径与 awake 一致（字符数 × 2），并标记 estimated。
 */
export function turnUsage(turn) {
  const replies = (turn?.blocks || []).filter((block) => block.kind === 'reply' && block.usage)
  if (replies.length) {
    const merged = {}
    for (const block of replies) {
      const usage = block.usage
      for (const [key, value] of Object.entries(usage)) {
        if (typeof value === 'number' && Number.isFinite(value)) {
          merged[key] = (merged[key] || 0) + value
        }
      }
    }
    return { ...merged, estimated: false }
  }

  /* 没有真实 usage：按事件文本长度估算（与 awake 的字符数 × 2 一致） */
  const text = (turn?.blocks || [])
    .map((block) => {
      if (block.kind === 'reply' || block.kind === 'reasoning') return block.text || ''
      if (block.kind === 'tool') return `${block.name || ''}${block.result ? JSON.stringify(block.result) : ''}`
      return ''
    })
    .join('')
  return { estimated_tokens: text.length * 2, estimated: true }
}

/** 一轮的总 token 数 */
export function totalTokenUsage(usage) {
  if (!usage) return 0
  const explicit = numericUsage(usage, 'total_tokens')
  if (explicit > 0) return explicit
  return (
    numericUsage(usage, 'input_tokens', 'prompt_tokens') +
    numericUsage(usage, 'output_tokens', 'completion_tokens') +
    numericUsage(usage, 'cached_input_tokens', 'cache_read_input_tokens') +
    numericUsage(usage, 'cache_creation_input_tokens') +
    numericUsage(usage, 'estimated_tokens')
  )
}

/** usage 字段名 → 中文标签（保留原 key 便于对照服务商文档） */
const USAGE_LABELS = {
  prompt_tokens: '输入 tokens',
  completion_tokens: '输出 tokens',
  total_tokens: '合计 tokens',
  input_tokens: '输入 tokens',
  output_tokens: '输出 tokens',
  cached_input_tokens: '缓存输入 tokens',
  cache_read_input_tokens: '缓存输入 tokens',
  cache_creation_input_tokens: '缓存写入 tokens',
  reasoning_tokens: '推理 tokens',
  estimated_tokens: '估算 tokens'
}

/** 把 usage 摊平成 [{ key, value }] 明细行 */
export function usageRows(usage, prefix = '') {
  if (!usage || typeof usage !== 'object') return []
  return Object.entries(usage).flatMap(([key, value]) => {
    if (key === 'estimated') return []
    const path = prefix ? `${prefix}.${key}` : key
    if (Array.isArray(value)) return value.flatMap((item, index) => usageRows({ [index]: item }, path))
    if (value && typeof value === 'object') return usageRows(value, path)
    if (typeof value !== 'number' || !Number.isFinite(value)) return []
    const label = USAGE_LABELS[path]
    return [{ key: label && !prefix ? `${label}（${path}）` : path, value }]
  })
}

/** token 数量的紧凑展示：1234 → 1.2k */
export function formatTokenUsage(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return '0 tokens'
  const unit = number >= 1_000_000 ? { divisor: 1_000_000, suffix: 'm' }
    : number >= 1_000 ? { divisor: 1_000, suffix: 'k' }
      : null
  if (!unit) return `${Math.round(number)} tokens`
  const scaled = number / unit.divisor
  return `${(scaled >= 10 ? scaled.toFixed(0) : scaled.toFixed(1)).replace(/\.0$/, '')}${unit.suffix}`
}

/** 简要结果文本（失败信息优先） */
export function toolResultSummary(result) {
  if (!result) return ''
  if (typeof result === 'string') return result
  if (result.error) return String(result.error)
  if (result.content !== undefined) return String(result.content)
  try {
    return JSON.stringify(result)
  } catch (_error) {
    return String(result)
  }
}
