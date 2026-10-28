import { joinUrl, readJsonOrSSE } from '../model/http.js'
import { AppError } from '../common/errors.js'

function toWireMessages(messages, system, config = {}) {
  const wire = []
  if (system) wire.push({ role: 'system', content: system })
  for (const message of messages) {
    if (message.role === 'tool') {
      wire.push({
        role: 'tool',
        tool_call_id: message.tool_call_id,
        content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
      })
      continue
    }
    if (message.role === 'assistant') {
      const item = { role: 'assistant', content: message.content || '' }
      if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
        item.content = message.content || null
        item.tool_calls = message.tool_calls.map((call) => ({
          id: call.id,
          type: 'function',
          function: {
            name: call.name,
            arguments:
              typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments || {})
          }
        }))
      }
      // 部分推理模型（Kimi / GLM / DeepSeek 等）在工具往返时要求回传 reasoning_content
      if (message.reasoning && config.provider_config?.reasoning_passthrough) {
        item.reasoning_content = message.reasoning
      }
      wire.push(item)
      continue
    }
    if (Array.isArray(message.content)) {
      wire.push({
        role: message.role,
        content: message.content.map((part) =>
          part?.type === 'image'
            ? { type: 'image_url', image_url: { url: part.data_url } }
            : { type: 'text', text: String(part?.text ?? '') }
        )
      })
      continue
    }
    wire.push({ role: message.role, content: message.content })
  }
  return wire
}

export function buildOpenAIRequest(config, messages, tools, options = {}) {
  const params = { ...(config.model_params || {}), ...(config.additional_params || {}), ...(options.params || {}) }
  const body = {
    model: config.model.model_id,
    messages: toWireMessages(messages, config.system, config),
    stream: options.stream !== false,
    ...params
  }
  if (tools && tools.length) {
    body.tools = tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters || { type: 'object', properties: {} }
      }
    }))
    body.tool_choice = options.toolChoice || 'auto'
  }
  if (body.stream && config.provider_config?.stream_options !== false) {
    body.stream_options = { include_usage: true }
  }
  if (body.stream) {
    body.stream_options = { include_usage: true }
  }
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.api_key}`,
    ...(config.provider_config?.headers || {})
  }
  const url = joinUrl(config.base_url, config.api_path || config.api || '/chat/completions')
  return { url, headers, body }
}

export async function streamOpenAI({ config, messages, tools, signal, onDelta }) {
  const { url, headers, body } = buildOpenAIRequest(config, messages, tools)
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

  const result = {
    content: '',
    reasoning: '',
    toolCalls: [],
    usage: null,
    finishReason: null,
    raw: null
  }
  const toolBuffers = new Map()

  const consume = (chunk) => {
    if (chunk.usage) result.usage = chunk.usage
    const choice = chunk.choices?.[0]
    if (!choice) return
    const delta = choice.delta || choice.message || {}
    const reasoning = delta.reasoning_content || delta.reasoning
    if (reasoning) {
      result.reasoning += reasoning
      onDelta?.({ type: 'reasoning', text: reasoning })
    }
    if (typeof delta.content === 'string' && delta.content) {
      result.content += delta.content
      onDelta?.({ type: 'text', text: delta.content })
    }
    for (const call of delta.tool_calls || []) {
      const index = call.index ?? 0
      if (!toolBuffers.has(index)) toolBuffers.set(index, { id: '', name: '', argumentsText: '' })
      const buffer = toolBuffers.get(index)
      if (call.id) buffer.id = call.id
      if (call.function?.name) buffer.name = call.function.name
      if (call.function?.arguments) {
        buffer.argumentsText += call.function.arguments
        onDelta?.({ type: 'tool_call_delta', index, text: call.function.arguments })
      }
      if (buffer.id && buffer.name) {
        onDelta?.({ type: 'tool_call_start', index, id: buffer.id, name: buffer.name })
      }
    }
    if (choice.finish_reason) result.finishReason = choice.finish_reason
  }

  const mode = await readJsonOrSSE(response, (message) => {
    if (message.done) return
    if (message.data) {
      if (message.whole) {
        result.raw = message.data
        const choice = message.data.choices?.[0]
        if (choice) {
          const content = choice.message?.content || ''
          if (content) {
            result.content += content
            onDelta?.({ type: 'text', text: content })
          }
          for (const [index, call] of (choice.message?.tool_calls || []).entries()) {
            toolBuffers.set(index, {
              id: call.id,
              name: call.function?.name,
              argumentsText: call.function?.arguments || ''
            })
          }
          result.finishReason = choice.finish_reason || null
        }
        result.usage = message.data.usage || null
        return
      }
      consume(message.data)
    }
  })
  void mode

  for (const [index, buffer] of [...toolBuffers.entries()].sort((a, b) => a[0] - b[0])) {
    let parsed = {}
    try {
      parsed = buffer.argumentsText ? JSON.parse(buffer.argumentsText) : {}
    } catch (_error) {
      parsed = { __raw: buffer.argumentsText }
    }
    result.toolCalls.push({
      id: buffer.id || `call_${index}`,
      name: buffer.name,
      arguments: parsed,
      argumentsText: buffer.argumentsText
    })
  }

  return result
}

export async function fetchOpenAIModels(config) {
  const headers = {
    Authorization: `Bearer ${config.api_key}`,
    ...(config.provider_config?.headers || {})
  }
  const response = await fetch(joinUrl(config.base_url, '/models'), { headers })
  if (!response.ok) {
    throw new AppError(`拉取模型失败（HTTP ${response.status}）`, 'REMOTE_MODELS_FAILED')
  }
  const payload = await response.json()
  return (payload.data || []).map((item) => ({ id: item.id, display_name: item.id }))
}
