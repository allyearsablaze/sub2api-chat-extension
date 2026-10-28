import { streamOpenAI } from './openai.js'
import { streamAnthropic } from './anthropic.js'
import { AppError } from '../common/errors.js'

export { fetchOpenAIModels } from './openai.js'
export { fetchAnthropicModels } from './anthropic.js'

/**
 * 统一模型调用入口：按供应商协议分派。
 * config 由 repository/catalog.resolveModelConfig 解析得到。
 */
export async function streamChat({ config, messages, tools = [], system = '', signal, onDelta }) {
  if (!config?.api_key) {
    throw new AppError(`供应商「${config?.provider?.name || '未知'}」未配置 API Key`, 'MODEL_KEY_MISSING')
  }
  const payload = { ...config, system }
  if (config.kind === 'anthropic') {
    return streamAnthropic({ config: payload, messages, tools, signal, onDelta })
  }
  return streamOpenAI({ config: payload, messages, tools, signal, onDelta })
}

/** 轻量连通性测试：只发一条最小消息 */
export async function testProviderConnection(config) {
  const started = Date.now()
  const result = await streamChat({
    config,
    messages: [{ role: 'user', content: 'ping' }],
    tools: [],
    system: '收到消息后仅回复 pong。'
  })
  return {
    latency_ms: Date.now() - started,
    reply: (result.content || '').slice(0, 120),
    usage: result.usage
  }
}
