import { joinUrl, readJsonOrSSE } from '../model/http.js'
import { AppError } from '../common/errors.js'

function toAnthropicMessages(messages) {
  const wire = []
  for (const message of messages) {
    if (message.role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: message.tool_call_id,
        content:
          typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '')
      }
      const last = wire[wire.length - 1]
      if (last && last.role === 'user' && Array.isArray(last.content)) {
        last.content.push(block)
      } else {
        wire.push({ role: 'user', content: [block] })
      }
      continue
    }
    if (message.role === 'assistant') {
      const blocks = []
      if (message.content) blocks.push({ type: 'text', text: message.content })
      for (const call of message.tool_calls || []) {
        blocks.push({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: typeof call.arguments === 'string' ? safeParse(call.arguments) : call.arguments || {}
        })
      }
      wire.push({ role: 'assistant', content: blocks.length ? blocks : [{ type: 'text', text: '' }] })
      continue
    }
    // Anthropic 要求 user / assistant 严格交替：连续的 user 消息必须合并成一条
    const userBlocks = Array.isArray(message.content)
      ? message.content
          .map((part) => {
            if (part?.type === 'image') {
              const parsed = splitDataUrl(part.data_url)
              if (!parsed) return null
              return {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: part.media_type || parsed.mediaType,
                  data: parsed.data
                }
              }
            }
            return { type: 'text', text: String(part?.text ?? '') }
          })
          .filter(Boolean)
      : [{ type: 'text', text: String(message.content ?? '') }]
    const last = wire[wire.length - 1]
    if (last && last.role === 'user' && Array.isArray(last.content)) {
      last.content.push(...userBlocks)
    } else {
      wire.push({ role: 'user', content: userBlocks })
    }
  }
  return wire
}

/** data URL → { mediaType, data }（Anthropic 的 image block 只接受裸 base64） */
function splitDataUrl(dataUrl) {
  const raw = String(dataUrl || '')
  const comma = raw.indexOf(',')
  if (!raw.startsWith('data:') || comma < 0) return null
  const head = raw.slice(5, comma)
  return {
    mediaType: head.split(';')[0] || 'image/png',
    data: raw.slice(comma + 1)
  }
}

function safeParse(text) {
  try {
    return JSON.parse(text)
  } catch (_error) {
    return { __raw: text }
  }
}

export function buildAnthropicRequest(config, messages, tools, options = {}) {
  const params = { ...(config.model_params || {}), ...(config.additional_params || {}), ...(options.params || {}) }
  const body = {
    model: config.model.model_id,
    max_tokens: params.max_tokens || 4096,
    messages: toAnthropicMessages(messages),
    stream: options.stream !== false,
    ...params
  }
  delete body.max_tokens
  body.max_tokens = params.max_tokens || 4096
  if (config.system) body.system = config.system
  if (tools && tools.length) {
    body.tools = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters || { type: 'object', properties: {} }
    }))
    if (options.toolChoice) body.tool_choice = options.toolChoice
  }
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': config.api_key,
    'anthropic-version': config.anthropic_version || '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
    ...(config.provider_config?.headers || {})
  }
  const url = joinUrl(config.base_url, config.api_path || config.api || '/v1/messages')
  return { url, headers, body }
}

export async function streamAnthropic({ config, messages, tools, signal, onDelta }) {
  const { url, headers, body } = buildAnthropicRequest(config, messages, tools)
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new AppError(`模型请求失败（HTTP ${response.status}）：${text.slice(0, 500)}`, 'MODEL_HTTP_ERROR', {
      status: response.status
    })
  }

  const result = { content: '', reasoning: '', toolCalls: [], usage: null, finishReason: null, raw: null }
  const blocks = new Map()

  const consume = (event) => {
    const type = event.type
    if (type === 'message_start') {
      result.usage = event.message?.usage || null
      return
    }
    if (type === 'content_block_start') {
      const index = event.index ?? 0
      const block = event.content_block || {}
      blocks.set(index, { type: block.type, id: block.id, name: block.name, json: '', text: '' })
      if (block.type === 'tool_use') {
        onDelta?.({ type: 'tool_call_start', index, id: block.id, name: block.name })
      }
      return
    }
    if (type === 'content_block_delta') {
      const index = event.index ?? 0
      const delta = event.delta || {}
      const buffer = blocks.get(index) || { json: '', text: '' }
      if (delta.type === 'text_delta') {
        result.content += delta.text || ''
        onDelta?.({ type: 'text', text: delta.text || '' })
      } else if (delta.type === 'thinking_delta') {
        const text = delta.thinking || ''
        result.reasoning += text
        onDelta?.({ type: 'reasoning', text })
      } else if (delta.type === 'input_json_delta') {
        buffer.json += delta.partial_json || ''
        onDelta?.({ type: 'tool_call_delta', index, text: delta.partial_json || '' })
      }
      blocks.set(index, buffer)
      return
    }
    if (type === 'message_delta') {
      if (event.delta?.stop_reason) result.finishReason = event.delta.stop_reason
      if (event.usage) result.usage = { ...(result.usage || {}), ...event.usage }
    }
  }

  await readJsonOrSSE(response, (message) => {
    if (message.done) return
    if (message.whole) {
      result.raw = message.data
      for (const block of message.data.content || []) {
        if (block.type === 'text') {
          result.content += block.text || ''
          onDelta?.({ type: 'text', text: block.text || '' })
        }
        if (block.type === 'tool_use') {
          result.toolCalls.push({
            id: block.id,
            name: block.name,
            arguments: block.input || {},
            argumentsText: JSON.stringify(block.input || {})
          })
        }
      }
      result.usage = message.data.usage || null
      result.finishReason = message.data.stop_reason || null
      return
    }
    if (message.data) consume(message.data)
  })

  if (!result.raw) {
    for (const [index, block] of [...blocks.entries()].sort((a, b) => a[0] - b[0])) {
      if (block.type !== 'tool_use') continue
      result.toolCalls.push({
        id: block.id || `tool_${index}`,
        name: block.name,
        arguments: block.json ? safeParse(block.json) : {},
        argumentsText: block.json || ''
      })
    }
  }

  return result
}

export async function fetchAnthropicModels(config) {
  const headers = {
    'x-api-key': config.api_key,
    'anthropic-version': config.anthropic_version || '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true'
  }
  const response = await fetch(joinUrl(config.base_url, '/v1/models'), { headers })
  if (!response.ok) {
    throw new AppError(`拉取模型失败（HTTP ${response.status}）`, 'REMOTE_MODELS_FAILED')
  }
  const payload = await response.json()
  return (payload.data || []).map((item) => ({ id: item.id, display_name: item.display_name || item.id }))
}
