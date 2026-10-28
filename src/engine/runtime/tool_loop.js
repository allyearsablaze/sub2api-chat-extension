import { appendEvent, updateEvent } from '../repository/session.js'
import { toEventVo } from '../repository/event_vo.js'
import { streamChat } from '../model_provider/index.js'
import { missingRequiredParams } from './tools/registry.js'
import { AppError, isAbortError, toErrorMessage } from '../common/errors.js'
import { toNumberOrNull } from '../common/json.js'
import { buildUserContent } from '../model/message_content.js'
import { serializeToolResultForContext } from '../model/tool_result_summary.js'

const TOOL_RESULT_MAX_CHARS = 20000
/* 重试次数不设上限，单次退避必须有上限：否则 2^n 增长会让第 20 次重试等待数天 */
const MAX_RETRY_BACKOFF_MS = 60000
/* 流式内容的推送节流：避免每个增量都推一次完整事件 */
const STREAM_PUSH_INTERVAL_MS = 120
/* 累积字符达到该阈值就立刻刷新一次，避免长文本迟迟不出现 */
const STREAM_FLUSH_CHAR_THRESHOLD = 24

function emitSafe(emit, event) {
  try {
    emit?.(event)
  } catch (_error) {
    /* 事件通道已关闭时忽略 */
  }
}

/**
 * 推送事件快照。
 *
 * 实时推送与历史拉取必须使用同一种载荷（事件 VO），
 * 前端才能把实时事件 upsert 进同一个事件数组，由同一个渲染器渲染。
 * 否则会出现「流式态」与「完成态」两套外观。
 */
function emitEvent(emit, row) {
  const vo = toEventVo(row)
  if (!vo) return
  emitSafe(emit, { type: 'event', event: vo })
}

/**
 * 事件流更新器：把「累积内容 + 落库 + 推送」串成一条串行流水线。
 * revision 由 updateEvent 自增，前端据此判断新旧，避免乱序覆盖。
 *
 * 刷新策略对齐 awake-claw 的流式落库：
 *   - 首帧立即落库推送（否则首个字要等一个节流窗口才出现，看起来像「一次性输出」）；
 *   - 之后按「字符阈值 or 时间间隔」触发刷新，高频小增量不会压垮存储；
 *   - 落库是串行的，保证 revision 与内容严格递增。
 */
function createEventStream({ emit, eventId, sessionId, turnId, parentEventId, eventType }) {
  let timer = null
  let chain = Promise.resolve()
  let pending = null
  let closed = false
  let firstPush = true
  let lastFlushAt = Date.now()
  let pendingChars = 0

  const write = async (patch) => {
    /* 调用方传的是「生成 patch 的函数」，必须先求值再落库。
     * 早前直接把函数当对象写进 updateEvent，导致流式中间帧的内容从未落库，
     * 前端直到最后一次 flush 才拿到全文，表现为「一次性输出一大段」。 */
    const resolved = typeof patch === 'function' ? patch() : patch
    if (!resolved) return null
    const row = await updateEvent(eventId, resolved)
    if (row) emitEvent(emit, row)
    return row
  }

  const commit = async (buildPatch) => {
    pending = null
    pendingChars = 0
    lastFlushAt = Date.now()
    chain = chain.then(() => write(buildPatch)).catch(() => null)
  }

  const schedule = (buildPatch, chars = 0) => {
    if (closed) return
    pending = buildPatch
    pendingChars += chars
    /* 首帧立即推：让用户第一时间看到第一个字 */
    if (firstPush) {
      firstPush = false
      commit(pending)
      return
    }
    const due =
      pendingChars >= STREAM_FLUSH_CHAR_THRESHOLD || Date.now() - lastFlushAt >= STREAM_PUSH_INTERVAL_MS
    if (due) {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      commit(pending)
      return
    }
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      if (!pending) return
      commit(pending)
    }, STREAM_PUSH_INTERVAL_MS)
  }

  return {
    /** 节流推送：高频增量按阈值合并 */
    push(buildPatch, chars = 0) {
      schedule(buildPatch, chars)
    },
    /** 结束前把最后一次改动落库并推送 */
    async flush(patch) {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      const last = pending
      pending = null
      pendingChars = 0
      chain = chain.then(() => write(patch ?? last)).catch(() => null)
      await chain
    },
    async close() {
      closed = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      pending = null
    }
  }
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

/**
 * 工具结果 → 历史消息内容。
 *
 * 走 summarizeToolResult：图片（base64 data URL）会被替换成占位描述。
 * 否则生图结果动辄 2MB base64，一两轮就超出上下文上限。
 * 事件里仍保存完整结果，界面照常显示图片。
 */
/**
 * 工具结果 → 本轮循环内的 tool 消息。
 *
 * 关键区别：**本轮循环内不压缩图片**。
 * read_image 的意义就是把图交给模型看，如果这里把 data_url 换成
 * 「[图片已省略]」，模型拿到只剩元信息，等于白调一次——
 * 实测模型会明确说「我看不到，只有占位标记」。
 *
 * 压缩只发生在「组装历史」时（buildHistoryMessages），
 * 也就是每次用户新发消息时，对上一轮及更早的图片做降级。
 * 本轮必须完整，否则这一轮的推理就断了。
 */
function serializeToolResult(payload) {
  return serializeToolResultForContext(payload, { budget: TOOL_RESULT_MAX_CHARS })
}

/**
 * 从工具结果里取出可下发的图片。
 * 只对「读取图片」类结果生效——生成/编辑的结果只带 ID，
 * 让模型显式调 read_image 才能看到，避免每轮都自动塞图。
 */
function extractInlineImage(payload) {
  if (!payload || typeof payload !== 'object') return null
  const dataUrl = payload.data_url
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return null
  const m = /^data:([^;,]+);base64,/.exec(dataUrl)
  if (!m) return null
  // 太小的大概率不是真图，避免误判
  if (dataUrl.length < 1024) return null
  return { data_url: dataUrl, mime: m[1], id: payload.id || '' }
}

/** 去掉结果里的 base64，只保留可读的元信息 */
function stripInlineImage(payload) {
  if (!payload || typeof payload !== 'object') return payload
  const out = { ...payload }
  const dataUrl = out.data_url
  if (typeof dataUrl === 'string') {
    const bytes = Math.round((dataUrl.length * 3) / 4)
    delete out.data_url
    out.bytes = out.bytes || bytes
    out.note = '图片内容已作为独立消息发送，此处只保留元信息'
  }
  if (Array.isArray(out.images)) {
    out.images = out.images.map((img) => {
      if (!img || typeof img !== 'object') return img
      const clone = { ...img }
      delete clone.data_url
      delete clone.url
      return clone
    })
  }
  return out
}

function withTimeout(promise, timeoutMs, toolName) {
  if (!timeoutMs || timeoutMs <= 0) return promise
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new AppError(`工具 ${toolName} 执行超时（${Math.round(timeoutMs / 1000)}s）`, 'TOOL_TIMEOUT'))
    }, timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

function sleep(ms, signal) {
  if (!ms || ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new AppError('任务已停止', 'TASK_CANCELLED'))
    }
    if (signal?.aborted) {
      clearTimeout(timer)
      reject(new AppError('任务已停止', 'TASK_CANCELLED'))
      return
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

/** 哪些失败值得自动重试：限流、服务端错误、连接失败；参数错误与 4xx 不重试 */
function isRetryable(error) {
  if (!error || isAbortError(error)) return false
  const status = Number(error?.detail?.status ?? error?.status ?? 0)
  if (status === 408 || status === 409 || status === 429) return true
  if (status >= 500) return true
  if (status >= 400) return false
  const message = toErrorMessage(error).toLowerCase()
  if (message.includes('timeout') || message.includes('超时')) return true
  if (message.includes('failed to fetch') || message.includes('networkerror')) return true
  if (message.includes('fetch failed')) return true
  return false
}

/** 重试退避：按累计次数指数增长，但单次封顶，避免无上限重试时等待时间失控 */
export function retryDelayMs(retryBackoffMs, retryCount) {
  const exponential = Math.max(0, Number(retryBackoffMs) || 0) * 2 ** Math.max(0, retryCount - 1)
  return {
    delay: Math.min(MAX_RETRY_BACKOFF_MS, exponential),
    capped: exponential > MAX_RETRY_BACKOFF_MS
  }
}

async function streamWithRetry({
  sessionId,
  turnId,
  parentEventId,
  modelConfig,
  messages,
  tools,
  system,
  signal,
  maxRetries,
  retryBackoffMs,
  retryState,
  emit,
  onDelta
}) {
  let attempt = 0
  for (;;) {
    try {
      return await streamChat({ config: modelConfig, messages, tools, system, signal, onDelta })
    } catch (error) {
      if (signal?.aborted || !isRetryable(error) || attempt >= maxRetries) throw error
      attempt += 1
      /* 整轮累计：同一轮里多次重试合并进同一条事件，只更新计数与详情 */
      const retryCount = (retryState.count = (retryState.count || 0) + 1)
      const { delay, capped } = retryDelayMs(retryBackoffMs, retryCount)
      const message = toErrorMessage(error).slice(0, 300)
      const attempts = [
        ...(retryState.attempts || []),
        { retry_count: retryCount, at: new Date().toISOString(), delay_ms: delay, error: message }
      ].slice(-5)
      retryState.attempts = attempts
      const summary = `重试 ×${retryCount}`
      const context = {
        attempt,
        retry_count: retryCount,
        max_retries: maxRetries,
        delay_ms: delay,
        backoff_capped: capped,
        error: message,
        attempts
      }
      if (retryState.eventId) {
        const row = await updateEvent(retryState.eventId, { status: 'running', summary, context })
        emitEvent(emit, row)
      } else {
        const created = await appendEvent(sessionId, {
          turn_id: turnId,
          parent_event_id: parentEventId,
          event_type: 'model_retry',
          status: 'running',
          summary,
          context
        })
        retryState.eventId = created.id
        emitEvent(emit, created)
      }
      await sleep(delay, signal)
    }
  }
}

/**
 * 模型 + 工具的执行循环（主会话与 SubAgent 共用）。
 *
 * 负责：流式增量、每轮 model_reply 落库、自动重试、工具执行与事件、轮次上限收尾。
 * 调用方提供已经解析好的模型配置与工具集合，因此 SubAgent 可以复用同一套逻辑
 * 但使用独立的系统提示、消息序列与事件父节点。
 */
export async function runToolLoop({
  sessionId,
  turnId,
  parentEventId = null,
  modelConfig,
  system,
  messages,
  modelTools,
  toolMap,
  allowedSet,
  maxRounds,
  toolTimeoutMs,
  maxRetries = 0,
  retryBackoffMs = 800,
  drainAppends = null,
  onAppendsDelivered = null,
  signal,
  emit,
  ctx,
  closingPrompt = '（系统提示）工具调用轮次已达上限，请不要再请求工具，直接基于以上已获得的信息给出最终答复，并说明还有哪些未完成。',
  onRoundStart = null,
  onToolEvent = null
}) {
  const history = [...messages]
  let round = 0
  let finalContent = ''
  let lastEventId = null
  let hitRoundLimit = false
  const failureCounts = new Map()
  const retryState = { count: 0, eventId: null, attempts: [] }

  while (round < Math.max(1, maxRounds)) {
    round += 1
    if (signal?.aborted) throw new AppError('任务已停止', 'TASK_CANCELLED')
    onRoundStart?.(round)

    /* 追加消息：在当前轮的下一次模型请求前注入，模型本轮就能看到 */
    const appends = drainAppends ? await drainAppends(turnId) : []
    for (const item of appends) {
      const content = buildUserContent(item.content, (item.attachments || []).map((row) => ({
        meta: { id: row.id, file_name: row.file_name, content_type: row.content_type, size: row.size },
        image: String(row.content_type || '').toLowerCase().startsWith('image/') ? row : null
      })))
      history.push({ role: 'user', content })
    }

    let reasoningBuffer = ''
    let contentBuffer = ''
    const replyEvent = await appendEvent(sessionId, {
      turn_id: turnId,
      parent_event_id: parentEventId,
      event_type: 'model_reply',
      status: 'running',
      summary: '',
      context: { content: '', tool_calls: [], round }
    })
    lastEventId = replyEvent.id
    emitEvent(emit, replyEvent)

    /* 流式内容持续写回同一条事件并推送快照：实时态与完成态是同一条记录、同一渲染器 */
    const replyStream = createEventStream({
      emit,
      eventId: replyEvent.id,
      sessionId,
      turnId,
      parentEventId,
      eventType: 'model_reply'
    })

    const result = await streamWithRetry({
      sessionId,
      turnId,
      parentEventId,
      modelConfig,
      messages: history,
      tools: modelTools,
      system,
      signal,
      maxRetries,
      retryBackoffMs,
      retryState,
      emit,
      onDelta: (delta) => {
        if (delta.type === 'text') {
          contentBuffer += delta.text
          replyStream.push(
            () => ({
              status: 'running',
              summary: contentBuffer.slice(0, 120),
              context: { content: contentBuffer, reasoning: reasoningBuffer, tool_calls: [], round }
            }),
            delta.text.length
          )
        } else if (delta.type === 'reasoning') {
          reasoningBuffer += delta.text
          replyStream.push(
            () => ({
              status: 'running',
              summary: contentBuffer.slice(0, 120),
              context: { content: contentBuffer, reasoning: reasoningBuffer, tool_calls: [], round }
            }),
            delta.text.length
          )
        }
      }
    })

    contentBuffer = result.content || contentBuffer
    reasoningBuffer = result.reasoning || reasoningBuffer

    /* 模型已收到本轮请求里的追加内容，标记为已送达 */
    if (appends.length) {
      await onAppendsDelivered?.(appends)
    }

    await replyStream.flush({
      status: 'completed',
      summary: contentBuffer.slice(0, 120),
      context: {
        content: contentBuffer,
        reasoning: reasoningBuffer,
        tool_calls: result.toolCalls.map((call) => ({ id: call.id, name: call.name, arguments: call.arguments })),
        round,
        usage: result.usage || null
      }
    })
    await replyStream.close()

    if (!result.toolCalls.length) {
      history.push({ role: 'assistant', content: contentBuffer })
      finalContent = contentBuffer
      /**
       * 轮次收尾时再取一次追加内容（对齐 awake 的 claim_or_seal 语义）。
       *
       * 用户可能正好在模型回复的这段时间里点了追加：这时追加项是「本轮进行中」
       * 产生的，应该由本轮消费掉，而不是留给下一轮。
       * 取到就把它们注入并让模型再回一轮；取不到才真正结束本轮。
       */
      const sealed = drainAppends ? await drainAppends(turnId) : []
      if (sealed.length) {
        for (const item of sealed) {
          const content = buildUserContent(item.content, (item.attachments || []).map((row) => ({
            meta: { id: row.id, file_name: row.file_name, content_type: row.content_type, size: row.size },
            image: String(row.content_type || '').toLowerCase().startsWith('image/') ? row : null
          })))
          history.push({ role: 'user', content })
        }
        await onAppendsDelivered?.(sealed)
        continue
      }
      break
    }

    history.push({
      role: 'assistant',
      content: contentBuffer,
      reasoning: reasoningBuffer,
      tool_calls: result.toolCalls.map((call) => ({ id: call.id, name: call.name, arguments: call.arguments }))
    })

    for (const call of result.toolCalls) {
      if (signal?.aborted) throw new AppError('任务已停止', 'TASK_CANCELLED')
      const callEvent = await appendEvent(sessionId, {
        turn_id: turnId,
        parent_event_id: replyEvent.id,
        event_type: 'tool_call',
        status: 'running',
        summary: call.name,
        context: { id: call.id, name: call.name, arguments: call.arguments }
      })
      /* 让工具内部（如 subagent_run）能把子事件挂到本次调用下 */
      if (ctx) ctx.activeToolEventId = callEvent.id
      emitEvent(emit, callEvent)

      const tool = allowedSet.has(call.name) ? toolMap.get(call.name) : null
      let payload
      let ok = true
      /**
       * 用户已经点过停止：本轮不再执行新的工具调用，
       * 直接告诉模型「已取消」，让它基于现有结果收尾。
       */
      if (ctx?.toolSlot?.cancelled) {
        ok = false
        payload = { ok: false, error: '用户已停止本轮，请基于已有结果直接回答，不要再调用工具' }
      } else if (!tool) {
        ok = false
        payload = {
          ok: false,
          error: allowedSet.has(call.name)
            ? `未知工具：${call.name}`
            : `工具 ${call.name} 未对当前上下文开放，请改用已提供的工具`
        }
      } else if (call.arguments && typeof call.arguments === 'object' && '__raw' in call.arguments) {
        ok = false
        payload = {
          ok: false,
          error: '工具参数不是合法 JSON，请重新生成完整参数后重试',
          received: String(call.arguments.__raw || '').slice(0, 500)
        }
      } else {
        const missing = missingRequiredParams(tool.parameters, call.arguments || {})
        const signature = `${call.name}:${stableStringify(call.arguments || {})}`
        const failedTimes = failureCounts.get(signature) || 0
        if (missing.length) {
          ok = false
          payload = { ok: false, error: `缺少必填参数：${missing.join(', ')}`, required: missing }
        } else if (failedTimes >= 2) {
          ok = false
          payload = {
            ok: false,
            error: `同一调用已连续失败 ${failedTimes} 次，已阻止重复执行。请改变策略：先用 get_page_snapshot / get_element_info 检查页面，或换用其他工具`
          }
        } else {
          /* 工具执行期间挂上「工具取消槽」，并让 ctx.signal 指向工具专属信号：
           * 用户点取消时先停掉正在跑的工具，模型循环还能继续（对齐 awake 的 ToolBatch）。 */
          const toolAbort = new AbortController()
          const onOuterAbort = () => toolAbort.abort(signal?.reason || '任务已停止')
          signal?.addEventListener?.('abort', onOuterAbort, { once: true })
          const previousSignal = ctx?.signal
          if (ctx) {
            ctx.signal = toolAbort.signal
            ctx.toolSlot?.set?.((reason) => toolAbort.abort(reason || '用户已取消工具'))
          }
          try {
            /* 取消可能发生在工具真正开始前：已 aborted 的信号再注册监听不会触发 */
            if (toolAbort.signal.aborted) {
              throw new AppError('任务已停止', 'TASK_CANCELLED')
            }
            const toolPromise = Promise.resolve(
              tool.handler(call.arguments || {}, ctx)
            ).then((item) => item ?? { ok: true })
            /**
             * 取消工具 = 立刻中断这次调用，不等工具自己发现信号。
             * 工具侧若也监听了 ctx.signal，会自行收尾；这里保证用户点取消后马上有反馈。
             */
            const abortPromise = new Promise((_, reject) => {
              toolAbort.signal.addEventListener(
                'abort',
                () => reject(new AppError('工具已被取消', 'TASK_CANCELLED')),
                { once: true }
              )
            })
            /* 工具可声明自己的超时（如生图/编图需要 60–180 秒）。
             * 取「全局设置」与「工具声明」的较大值：
             * 用户把全局调小不该让生图必然超时，调大则对所有工具生效。 */
            const effectiveTimeout = Math.max(
              Number(toolTimeoutMs) || 0,
              Number(tool?.timeoutMs) || 0
            )
            const value = await withTimeout(
              Promise.race([toolPromise, abortPromise]),
              effectiveTimeout,
              call.name
            )
            payload = value
            ok = payload.ok !== false
          } catch (error) {
            ok = false
            payload = { ok: false, error: toErrorMessage(error) }
          } finally {
            signal?.removeEventListener?.('abort', onOuterAbort)
            if (ctx) ctx.signal = previousSignal
            ctx?.toolSlot?.clear?.()
          }
          if (ok) failureCounts.delete(signature)
          else failureCounts.set(signature, failedTimes + 1)
        }
      }

      /* 事件里存「去掉 base64」的结果：
       * 图片已归档在 image_cache，界面按 ID 取图即可。
       * 若把 1.2MB base64 写进事件，会话体积会随读图次数线性膨胀。 */
      const inlineImg = extractInlineImage(payload)
      const storedPayload = inlineImg ? stripInlineImage(payload) : payload

      const callRow = await updateEvent(callEvent.id, {
        status: ok ? 'completed' : 'failed',
        context: { id: call.id, name: call.name, arguments: call.arguments, result: storedPayload }
      })
      emitEvent(emit, callRow)
      const resultEvent = await appendEvent(sessionId, {
        turn_id: turnId,
        parent_event_id: callEvent.id,
        event_type: 'tool_result',
        status: ok ? 'completed' : 'failed',
        summary: ok ? '工具执行完成' : String(payload.error || '工具执行失败').slice(0, 120),
        context: { tool_call_id: call.id, name: call.name, ok, result: storedPayload }
      })
      emitEvent(emit, resultEvent)
      onToolEvent?.({ call, ok, payload, resultEvent })

      /* read_image 的 base64 不进工具结果，改为追加一条带图的消息。
       *
       * 原因：OpenAI 的 tool 消息只接受文本，图片塞进 content 也传不到模型；
       * 而 base64 留在 tool 结果里既占上下文又是无效负载。
       * 正确做法是把图作为独立的 user 消息块下发，工具结果只留元信息。
       */
      const inline = extractInlineImage(payload)
      const toolPayload = inline ? stripInlineImage(payload) : payload

      history.push({
        role: 'tool',
        tool_call_id: call.id,
        name: call.name,
        content: serializeToolResult(toolPayload),
      })

      if (inline) {
        history.push({
          role: 'user',
          content: [
            { type: 'text', text: `（这是图片 ${inline.id || ''} 的实际内容）` },
            { type: 'image', media_type: inline.mime, data_url: inline.data_url },
          ],
        })
      }
    }

    if (round >= maxRounds) {
      hitRoundLimit = true
      break
    }
  }

  // 轮次用尽时补一次「不带工具」的收尾调用，让模型基于已有结果作答，而不是空手结束
  if (hitRoundLimit) {
    const notice = await appendEvent(sessionId, {
      turn_id: turnId,
      parent_event_id: parentEventId,
      event_type: 'turn_notice',
      status: 'completed',
      summary: `已达到工具调用轮次上限（${maxRounds}）`,
      context: { content: `已达到工具调用轮次上限（${maxRounds}），将基于现有结果收尾。` }
    })
    emitEvent(emit, notice)
    try {
      const closingMessages = [...history, { role: 'user', content: closingPrompt }]
      /* 收尾回复同样先建事件再流式写入，与主回复保持同一种形态 */
      const closingEvent = await appendEvent(sessionId, {
        turn_id: turnId,
        parent_event_id: parentEventId,
        event_type: 'model_reply',
        status: 'running',
        summary: '',
        context: { content: '', tool_calls: [], round: round + 1, closing: true }
      })
      emitEvent(emit, closingEvent)
      const closingStream = createEventStream({
        emit,
        eventId: closingEvent.id,
        sessionId,
        turnId,
        parentEventId,
        eventType: 'model_reply'
      })
      let closingContent = ''
      const closing = await streamWithRetry({
        sessionId,
        turnId,
        parentEventId,
        modelConfig,
        messages: closingMessages,
        tools: [],
        system,
        signal,
        maxRetries,
        retryBackoffMs,
        retryState,
        emit,
        onDelta: (delta) => {
          if (delta.type === 'text') {
            closingContent += delta.text
            closingStream.push(() => ({
              status: 'running',
              summary: closingContent.slice(0, 120),
              context: { content: closingContent, tool_calls: [], round: round + 1, closing: true }
            }))
          }
        }
      })
      closingContent = closing.content || closingContent
      finalContent = closingContent
      await closingStream.flush({
        status: 'completed',
        summary: finalContent.slice(0, 120),
        context: { content: finalContent, tool_calls: [], round: round + 1, closing: true }
      })
      await closingStream.close()
      lastEventId = closingEvent.id
    } catch (error) {
      emitSafe(emit, {
        type: 'notice',
        turnId,
        parentEventId,
        text: `收尾回复失败：${toErrorMessage(error)}`
      })
    }
  }

  return { content: finalContent, rounds: round, messages: history, lastEventId, hitRoundLimit }
}

export { isRetryable, sleep, toNumberOrNull }
