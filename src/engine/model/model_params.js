/**
 * 模型参数表（与 awake-claw 的 web/src/modelParamSchema.js 对齐）。
 *
 * 这一层解决三件事：
 * 1. 不同协议（openai chat/completions、openai responses、anthropic messages）各自合法的参数不同，
 *    面板只能展示当前协议真正支持的字段，避免把 `max_tokens` 发给 responses 之类的 400。
 * 2. 参数有「协议缺省 → 模型默认 → 会话覆盖」三层，这里统一定义缺省值。
 * 3. 执行参数（工具轮次、重试、工具保留）与模型参数分属不同维度，单独成组。
 *
 * 文件同时被 service worker 与前端引用，不依赖任何浏览器 API。
 */

export const DEFAULT_CONTEXT_WINDOW = 32000
export const DEFAULT_MAX_HISTORY_MESSAGES = 0
export const DEFAULT_MAX_TOOL_CALL_ROUNDS = 30
export const DEFAULT_MAX_RETRIES = 2
export const DEFAULT_TOOL_RETENTION_ROUNDS = 0
export const DEFAULT_TOOL_TIMEOUT_SECS = 60
export const DEFAULT_MAX_TOKENS = 4096
export const DEFAULT_MODALITIES = ['text']
/** 历史 token 估算比例：字符数 × 该比例（awake-claw 默认 0.35） */
export const DEFAULT_HISTORY_TOKEN_RATIO = 0.35
export const HISTORY_TOKEN_RATIO_MIN = 0.05
export const HISTORY_TOKEN_RATIO_MAX = 5

export const MODALITY_VALUES = ['text', 'image', 'audio', 'video', 'file']
export const MODALITY_LABELS = {
  text: '文本',
  image: '图片',
  audio: '音频',
  video: '视频',
  file: '文件'
}

/** 参数字段的中文标题（含协议嵌套字段） */
export const PARAM_FIELD_TITLES = {
  temperature: '温度',
  top_p: '核采样（Top-P）',
  top_k: 'Top-K 采样',
  frequency_penalty: '频率惩罚',
  presence_penalty: '存在惩罚',
  logit_bias: '词元偏好',
  max_completion_tokens: '最大输出 Tokens',
  max_output_tokens: '最大输出 Tokens',
  max_tokens: '最大输出 Tokens',
  n: '候选回复数',
  reasoning_effort: '推理强度',
  'reasoning.effort': '推理强度',
  'reasoning.summary': '推理摘要',
  'thinking.type': '思考模式',
  'thinking.budget_tokens': '思考预算 Tokens',
  'text.verbosity': '输出详略',
  'text.format.type': '输出格式',
  'text.format.name': '结构名称',
  'text.format.strict': '严格模式',
  'text.format.schema': 'JSON Schema',
  verbosity: '输出详略',
  tool_choice: '工具选择策略',
  parallel_tool_calls: '并行工具调用',
  stream: '流式输出',
  'stream_options.include_usage': '返回用量统计',
  'response_format.type': '响应格式',
  'response_format.json_schema.name': '结构名称',
  'response_format.json_schema.strict': '严格模式',
  'response_format.json_schema.schema': 'JSON Schema',
  truncation: '截断策略',
  'output_config.effort': '推理强度',
  'output_config.format.type': '输出格式',
  'output_config.format.schema': 'JSON Schema',
  logprobs: '返回概率信息',
  top_logprobs: '候选概率数量',
  stop_sequences: '停止序列'
}

/** 参数说明（中文） */
export const PARAM_FIELD_HELP = {
  temperature: '越低越稳定，越高越发散',
  top_p: '按累积概率截断候选词，与温度二选一调整',
  top_k: '只在概率最高的前 K 个词中采样',
  frequency_penalty: '降低重复用词的倾向',
  presence_penalty: '鼓励模型提及新话题',
  reasoning_effort: '推理模型的有效强度，部分模型不支持',
  'reasoning.effort': '推理模型的有效强度，部分模型不支持',
  'thinking.type': '是否开启思考过程',
  'thinking.budget_tokens': '思考过程可用的 token 上限',
  max_completion_tokens: '单次回复的最大 token 数',
  max_output_tokens: '单次回复的最大 token 数',
  max_tokens: '单次回复的最大 token 数',
  tool_choice: '自动由模型决定，必须调用会强制至少用一个工具，禁止调用则只用文字回答',
  parallel_tool_calls: '允许模型在同一轮并行调用多个工具',
  'response_format.type': 'JSON 对象要求返回 JSON；JSON Schema 需要另外提供 schema',
  'text.format.type': 'JSON 对象 / JSON Schema 结构化输出',
  stream: '关闭后一次性返回完整结果'
}

/** 枚举值的中文显示 */
export const PARAM_OPTION_LABELS = {
  none: '关闭',
  minimal: '最小',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最大',
  auto: '自动',
  concise: '简洁',
  detailed: '详细',
  enabled: '开启',
  disabled: '关闭',
  adaptive: '自适应',
  text: '纯文本',
  json_object: 'JSON 对象',
  json_schema: 'JSON Schema',
  required: '必须调用'
}

/** 取枚举值的中文标签；未收录时回落原值 */
export function paramOptionLabel(option) {
  return PARAM_OPTION_LABELS[option] || option
}

export function modalityLabel(value) {
  return MODALITY_LABELS[value] || value
}

/** 会话运行时的 API 协议中文标签 */
export const API_PROTOCOL_LABELS = {
  completions: '对话补全（chat/completions）',
  responses: '响应接口（responses）',
  messages: '消息接口（messages）'
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/** 历史 token 估算：字符数 × 比例，向上取整 */
export function estimateHistoryTokens(text, ratio = DEFAULT_HISTORY_TOKEN_RATIO) {
  const safeRatio = defaultHistoryTokenRatio(ratio)
  return Math.ceil(String(text || '').length * safeRatio)
}

/** 单条消息的 token 估算（含工具参数与结果） */
export function estimateMessageTokens(message, ratio = DEFAULT_HISTORY_TOKEN_RATIO) {
  if (!message) return 0
  const parts = []
  if (Array.isArray(message.content)) {
    /* 图片按固定成本估算，避免把 base64 当字符数算爆预算 */
    let images = 0
    for (const part of message.content) {
      if (part?.type === 'text') parts.push(part.text)
      else if (part?.type === 'image') images += 1
    }
    if (images) parts.push('image '.repeat(images * 200))
  } else {
    parts.push(message.content)
  }
  if (message.reasoning) parts.push(message.reasoning)
  if (message.tool_calls?.length) parts.push(JSON.stringify(message.tool_calls))
  return estimateHistoryTokens(parts.filter(Boolean).join('\n'), ratio)
}

/** 模型参数里的输出 token 上限 */
export function outputTokenLimit(modelParams = {}) {
  for (const key of ['max_completion_tokens', 'max_tokens', 'max_output_tokens']) {
    const num = Number(modelParams?.[key])
    if (Number.isFinite(num) && num > 0) return num
  }
  return 0
}

/**
 * 历史可用的 token 预算 = 上下文窗口 − 输出预留 − 系统提示占用。
 * 返回 0 表示不做预算裁剪（窗口未知）。
 */
export function historyTokenBudget({ contextWindow, modelParams, systemTokens = 0 } = {}) {
  const window = Number(contextWindow)
  if (!Number.isFinite(window) || window <= 0) return 0
  const reserved = outputTokenLimit(modelParams) + Math.max(0, Number(systemTokens) || 0)
  return Math.max(0, window - reserved)
}

/** 执行参数：工具轮次 / 模型重试 / 工具结果保留轮数 */
export const EXECUTION_PARAM_FIELDS = [
  {
    key: 'max_tool_call_rounds',
    label: 'max_tool_call_rounds',
    title: '工具调用轮次上限',
    help: '单轮对话里模型最多可以连续请求多少批工具。超出后会要求模型基于已有结果收尾。',
    type: 'number',
    min: 1,
    max: 200,
    step: 1
  },
  {
    key: 'max_retries',
    label: 'max_retries',
    title: '模型请求重试次数',
    help: '网络错误、429 与 5xx 时自动重试的次数，重试过程会写入时间线；0 表示跟随设置页的全局重试次数。次数不设上限，单次退避最长 60 秒。',
    type: 'number',
    min: 0,
    step: 1
  },
  {
    key: 'tool_call_retention_rounds',
    label: 'tool_call_retention_rounds',
    title: '工具结果保留轮数',
    help: '历史消息里保留最近几批工具调用明细；更早的只保留结论并折叠，避免上下文被工具输出占满。0 表示全部保留。',
    type: 'number',
    min: 0,
    max: 100,
    step: 1
  },
  {
    key: 'tool_timeout_ms',
    label: 'tool_timeout_ms',
    title: '工具超时（其他工具）',
    help: '非图片类工具的单次执行上限（毫秒）。图片生成/编辑有独立超时，不受此项影响。',
    type: 'number',
    min: 0,
    max: 600000,
    step: 5000
  }
]

/** 会话运行时参数：上下文窗口 / 历史条数 / 模态 / API 协议 */
export const SESSION_RUNTIME_FIELDS = [
  {
    key: 'context_window',
    label: 'context_window',
    title: '上下文窗口',
    help: '用于估算历史裁剪的 token 上限，留空按模型或系统默认。',
    type: 'number',
    min: 0,
    step: 1000,
    common: true
  },
  {
    key: 'max_history_messages',
    label: 'max_history_messages',
    title: '最大历史消息条数',
    help: '下发给模型的历史消息上限，0 表示不限制（由上下文窗口控制）。',
    type: 'number',
    min: 0,
    step: 1,
    common: true
  },
  {
    key: 'history_token_ratio',
    label: 'history_token_ratio',
    title: '历史 Token 比例',
    help: '估算历史 Token 时按字符数乘以该比例，默认 0.35；数值越大，保留的历史越少。',
    type: 'number',
    min: HISTORY_TOKEN_RATIO_MIN,
    max: HISTORY_TOKEN_RATIO_MAX,
    step: 0.05,
    common: true
  },
  {
    key: 'modalities',
    label: 'modalities',
    title: '输入模态',
    type: 'modality-list',
    common: true
  }
]

const GROUP_TITLES = {
  sampling: '采样',
  limits: '长度与数量',
  reasoning: '推理',
  structuredOutput: '结构化输出',
  tools: '工具行为',
  streamingCache: '流式与缓存',
  advanced: '高级'
}

export function groupTitle(group) {
  return GROUP_TITLES[group] || group
}

/** 供应商 kind → 实际请求协议 */
/**
 * 归一化出实际协议。
 *
 * 原版只在 kind==='anthropic' 时返回 messages——因为一个扩展里的供应商
 * 只有一种协议。但 sub2api 是统一网关：kind 统一是 openai-compatible，
 * 真实协议由用户显式选择（可能用同一把密钥访问 /v1/messages）。
 * 所以这里尊重显式指定的 api='messages'，否则用户选了 Messages
 * 拿到的还是 completions 字段集，填 max_tokens 反而发不出去。
 */
export function effectiveProviderApi(kind, api) {
  if (kind === 'anthropic') return 'messages'
  if (api === 'messages') return 'messages'
  return api === 'responses' ? 'responses' : 'completions'
}

export function isOpenAiCompatible(kind) {
  return kind === 'openai-compatible'
}

const openAiChatFields = [
  { key: 'temperature', group: 'sampling', type: 'number', min: 0, max: 2, step: 0.1, common: true },
  { key: 'top_p', group: 'sampling', type: 'number', min: 0, max: 1, step: 0.1 },
  { key: 'frequency_penalty', group: 'sampling', type: 'number', min: -2, max: 2, step: 0.1 },
  { key: 'presence_penalty', group: 'sampling', type: 'number', min: -2, max: 2, step: 0.1 },
  { key: 'logit_bias', group: 'sampling', type: 'json-object' },
  { key: 'max_completion_tokens', group: 'limits', type: 'number', min: 1, step: 1, common: true },
  { key: 'n', group: 'limits', type: 'number', min: 1, step: 1 },
  {
    key: 'reasoning_effort',
    group: 'reasoning',
    type: 'select',
    options: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
    common: true
  },
  {
    key: 'response_format.type',
    group: 'structuredOutput',
    type: 'select',
    options: ['text', 'json_object', 'json_schema']
  },
  {
    key: 'response_format.json_schema.name',
    group: 'structuredOutput',
    type: 'string',
    showWhen: { key: 'response_format.type', value: 'json_schema' }
  },
  {
    key: 'response_format.json_schema.strict',
    group: 'structuredOutput',
    type: 'boolean',
    showWhen: { key: 'response_format.type', value: 'json_schema' }
  },
  {
    key: 'response_format.json_schema.schema',
    group: 'structuredOutput',
    type: 'json-object',
    showWhen: { key: 'response_format.type', value: 'json_schema' }
  },
  { key: 'tool_choice', group: 'tools', type: 'tool-choice' },
  { key: 'parallel_tool_calls', group: 'tools', type: 'boolean' },
  { key: 'stream', group: 'streamingCache', type: 'boolean', common: true },
  { key: 'stream_options.include_usage', group: 'streamingCache', type: 'boolean' },
  { key: 'logprobs', group: 'advanced', type: 'boolean' },
  { key: 'top_logprobs', group: 'advanced', type: 'number', min: 0, max: 20, step: 1 },
  { key: 'verbosity', group: 'advanced', type: 'select', options: ['low', 'medium', 'high'] }
]

const openAiResponsesFields = [
  { key: 'temperature', group: 'sampling', type: 'number', min: 0, max: 2, step: 0.1, common: true },
  { key: 'top_p', group: 'sampling', type: 'number', min: 0, max: 1, step: 0.1 },
  { key: 'max_output_tokens', group: 'limits', type: 'number', min: 1, step: 1, common: true },
  {
    key: 'reasoning.effort',
    group: 'reasoning',
    type: 'select',
    options: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
    common: true
  },
  { key: 'reasoning.summary', group: 'reasoning', type: 'select', options: ['auto', 'concise', 'detailed'] },
  { key: 'text.verbosity', group: 'structuredOutput', type: 'select', options: ['low', 'medium', 'high'] },
  {
    key: 'text.format.type',
    group: 'structuredOutput',
    type: 'select',
    options: ['text', 'json_object', 'json_schema']
  },
  {
    key: 'text.format.name',
    group: 'structuredOutput',
    type: 'string',
    showWhen: { key: 'text.format.type', value: 'json_schema' }
  },
  {
    key: 'text.format.strict',
    group: 'structuredOutput',
    type: 'boolean',
    showWhen: { key: 'text.format.type', value: 'json_schema' }
  },
  {
    key: 'text.format.schema',
    group: 'structuredOutput',
    type: 'json-object',
    showWhen: { key: 'text.format.type', value: 'json_schema' }
  },
  { key: 'tool_choice', group: 'tools', type: 'tool-choice' },
  { key: 'parallel_tool_calls', group: 'tools', type: 'boolean' },
  { key: 'stream', group: 'streamingCache', type: 'boolean', common: true },
  { key: 'truncation', group: 'advanced', type: 'select', options: ['auto', 'disabled'] }
]

const anthropicFields = [
  { key: 'temperature', group: 'sampling', type: 'number', min: 0, max: 1, step: 0.1, common: true },
  { key: 'top_p', group: 'sampling', type: 'number', min: 0, max: 1, step: 0.1 },
  { key: 'top_k', group: 'sampling', type: 'number', min: 1, step: 1 },
  { key: 'max_tokens', group: 'limits', type: 'number', min: 1, step: 1, common: true },
  { key: 'stop_sequences', group: 'limits', type: 'string-list' },
  {
    key: 'thinking.type',
    group: 'reasoning',
    type: 'select',
    options: ['enabled', 'disabled', 'adaptive'],
    common: true
  },
  {
    key: 'thinking.budget_tokens',
    group: 'reasoning',
    type: 'number',
    min: 1,
    step: 256,
    showWhen: { key: 'thinking.type', values: ['enabled', 'adaptive'] }
  },
  /* Anthropic 的推理强度：后端 gateway_request.go 读 body.output_config.effort，
   * 且 enabled / adaptive 模式下才允许，disabled 时传会被上游拒绝。
   * haiku-5-5 在 disabled 下只支持 low/medium/high。 */
  {
    key: 'output_config.effort',
    group: 'reasoning',
    type: 'select',
    options: ['low', 'medium', 'high', 'xhigh', 'max'],
    showWhen: { key: 'thinking.type', values: ['enabled', 'adaptive'] }
  },
  { key: 'stream', group: 'streamingCache', type: 'boolean', common: true }
]

/** 兼容端点常见扩展参数（DeepSeek / 智谱 / 月之暗面等） */
const compatibleExtraFields = [
  { key: 'thinking.type', group: 'reasoning', type: 'select', options: ['enabled', 'disabled'] },
  {
    key: 'output_config.effort',
    group: 'reasoning',
    type: 'select',
    options: ['low', 'medium', 'high', 'xhigh', 'max']
  },
  {
    key: 'output_config.format.type',
    group: 'structuredOutput',
    type: 'select',
    options: ['json_schema']
  },
  {
    key: 'output_config.format.schema',
    group: 'structuredOutput',
    type: 'json-object',
    showWhen: { key: 'output_config.format.type', value: 'json_schema' }
  }
]

/** 当前协议可用的模型参数字段 */
/**
 * 当前协议可用的模型参数字段。
 *
 * 注意 compatibleExtraFields（thinking / output_config 等）只在**显式**要求
 * compatible=true 时才追加。sub2api 的 openai 族虽然底层用「openai-compatible」
 * 这个 kind 标记，但它对外呈现的是标准 OpenAI 协议——把第三方厂商的私有字段
 * （output_config 是 Anthropic/Vertex 风格）塞进去，用户填了反而会 400。
 * 所以这里不再按 kind 自动追加。
 */
export function modelParamFields(kind = 'openai', api = 'completions', compatible = false) {
  const protocol = effectiveProviderApi(kind, api)
  if (protocol === 'messages') return anthropicFields
  const fields = protocol === 'responses' ? openAiResponsesFields : openAiChatFields
  return compatible ? [...fields, ...compatibleExtraFields] : fields
}

/** 协议缺省参数（新建模型时作为初始值） */
export function defaultModelParams(kind = 'openai', api = 'completions') {
  if (kind === 'anthropic') {
    return { max_tokens: DEFAULT_MAX_TOKENS, stream: true }
  }
  if (effectiveProviderApi(kind, api) === 'responses') {
    return { stream: true, parallel_tool_calls: true, reasoning: { summary: 'auto' } }
  }
  return { stream: true, parallel_tool_calls: true, stream_options: { include_usage: true } }
}

export function defaultExecutionParams() {
  return {
    max_tool_call_rounds: DEFAULT_MAX_TOOL_CALL_ROUNDS,
    max_retries: DEFAULT_MAX_RETRIES,
    tool_call_retention_rounds: DEFAULT_TOOL_RETENTION_ROUNDS
  }
}

function clonePlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  try {
    return JSON.parse(JSON.stringify(value))
  } catch (_error) {
    return {}
  }
}

function valueAt(target, path) {
  return path.split('.').reduce((current, key) => (current == null ? undefined : current[key]), target)
}

function setValueAt(target, path, value) {
  const keys = path.split('.')
  let cursor = target
  for (const key of keys.slice(0, -1)) {
    if (!cursor[key] || typeof cursor[key] !== 'object' || Array.isArray(cursor[key])) cursor[key] = {}
    cursor = cursor[key]
  }
  cursor[keys[keys.length - 1]] = value
}

function isEmptyValue(value) {
  if (value === undefined || value === null) return true
  if (typeof value === 'string' && value.trim() === '') return true
  if (Array.isArray(value) && value.length === 0) return true
  return false
}

/** 用协议缺省补齐模型参数 */
export function modelParamsWithDefaults(kind, api, value) {
  return { ...defaultModelParams(kind, api), ...clonePlainObject(value) }
}

/** 用默认值补齐执行参数；空值不覆盖默认 */
export function executionParamsWithDefaults(value, defaults = defaultExecutionParams()) {
  const next = { ...defaults }
  for (const field of EXECUTION_PARAM_FIELDS) {
    const raw = value?.[field.key]
    if (raw === '' || raw === null || raw === undefined) continue
    const num = Number(raw)
    if (Number.isFinite(num)) next[field.key] = num
  }
  return next
}

/** 只保留合法的执行参数（不填默认值，便于区分「未设置」与「显式设为默认」） */
export function sanitizeExecutionParams(value) {
  const source = clonePlainObject(value)
  const next = {}
  for (const field of EXECUTION_PARAM_FIELDS) {
    const raw = source[field.key]
    if (raw === '' || raw === null || raw === undefined) continue
    const num = Number(raw)
    if (!Number.isFinite(num)) continue
    const min = field.min ?? -Infinity
    const max = field.max ?? Infinity
    next[field.key] = Math.min(max, Math.max(min, num))
  }
  return next
}

/** 只保留与默认值不同的执行参数，避免把一堆默认值写进 snapshot */
export function executionParamsForApi(value, defaults = defaultExecutionParams()) {
  const filtered = sanitizeExecutionParams(value)
  const next = {}
  for (const [key, item] of Object.entries(filtered)) {
    if (Number(item) === Number(defaults[key])) continue
    next[key] = item
  }
  return next
}

/** 按字段表清洗模型参数，剔除当前协议不认识、或空值的键 */
export function sanitizeModelParamsForApi(kind, api, value, compatible = false) {
  const source = clonePlainObject(value)
  const next = {}
  for (const field of modelParamFields(kind, api, compatible)) {
    const fieldValue = valueAt(source, field.key)
    if (isEmptyValue(fieldValue)) continue
    if (field.type === 'number') {
      const num = Number(fieldValue)
      if (!Number.isFinite(num)) continue
      setValueAt(next, field.key, num)
      continue
    }
    setValueAt(next, field.key, fieldValue)
  }
  return next
}

/** 把嵌套参数摊平成「字段 → 值」，供表单渲染 */
export function flattenModelParams(value) {
  const source = clonePlainObject(value)
  const flat = {}
  const walk = (node, prefix) => {
    for (const [key, item] of Object.entries(node || {})) {
      const path = prefix ? `${prefix}.${key}` : key
      if (item && typeof item === 'object' && !Array.isArray(item)) walk(item, path)
      else flat[path] = item
    }
  }
  walk(source, '')
  return flat
}

/** 把平铺字段写回嵌套对象 */
export function unflattenModelParams(flat = {}) {
  const next = {}
  for (const [path, value] of Object.entries(flat || {})) {
    if (isEmptyValue(value)) continue
    setValueAt(next, path, value)
  }
  return next
}

export function defaultContextWindow(value) {
  const num = Number(value)
  return Number.isFinite(num) && num > 0 ? num : DEFAULT_CONTEXT_WINDOW
}

export function defaultMaxHistoryMessages(value) {
  const num = Number(value)
  return Number.isFinite(num) && num >= 0 ? num : DEFAULT_MAX_HISTORY_MESSAGES
}

/** 历史 token 比例：必须是大于 0 的有限数，否则回落默认值 */
export function defaultHistoryTokenRatio(value) {
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) return DEFAULT_HISTORY_TOKEN_RATIO
  return clampNumber(num, HISTORY_TOKEN_RATIO_MIN, HISTORY_TOKEN_RATIO_MAX)
}

export function defaultModalities(value) {
  return Array.isArray(value) && value.length ? [...value] : [...DEFAULT_MODALITIES]
}

/** 附加参数以 JSON 文本编辑，回填时保持格式化 */
export function visibleAdditionalParamsText(value) {
  if (!value || typeof value !== 'object' || !Object.keys(value).length) return ''
  try {
    return JSON.stringify(value, null, 2)
  } catch (_error) {
    return ''
  }
}

export function parseAdditionalParamsText(text) {
  const raw = String(text || '').trim()
  if (!raw) return null
  const parsed = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('附加参数必须是 JSON 对象')
  }
  return parsed
}

/** 会话模型快照的默认结构 */
export function emptySessionParams() {
  return {
    api: '',
    context_window: DEFAULT_CONTEXT_WINDOW,
    max_history_messages: DEFAULT_MAX_HISTORY_MESSAGES,
    history_token_ratio: DEFAULT_HISTORY_TOKEN_RATIO,
    modalities: [...DEFAULT_MODALITIES],
    model_params: {},
    execution_params: defaultExecutionParams(),
    additional_params_text: '',
    provider_kind: '',
    model_label: '',
    provider_label: ''
  }
}

/**
 * 根据一次选择生成会话模型快照。
 * provider/model 为记录对象，overrides 为已有的用户覆盖值。
 */
export function buildSessionSnapshot({ provider, model, api, overrides = {} } = {}) {
  const kind = provider?.kind || overrides.provider_kind || 'openai'
  const protocol = effectiveProviderApi(kind, api || model?.api || provider?.api)
  const modelParams = sanitizeModelParamsForApi(
    kind,
    protocol,
    modelParamsWithDefaults(kind, protocol, {
      ...(model?.model_params || {}),
      ...(overrides.model_params || {})
    }),
    isOpenAiCompatible(kind)
  )
  const executionParams = sanitizeExecutionParams({
    ...(model?.execution_params || {}),
    ...(overrides.execution_params || {})
  })
  return {
    provider_id: provider?.id ?? overrides.provider_id ?? null,
    model_id: model?.id ?? overrides.model_id ?? null,
    provider_kind: kind,
    provider_label: provider?.name || overrides.provider_label || '',
    model_label: model?.alias || model?.model_id || overrides.model_label || '',
    api: protocol,
    context_window: defaultContextWindow(overrides.context_window ?? model?.context_window),
    max_history_messages: defaultMaxHistoryMessages(overrides.max_history_messages),
    history_token_ratio: defaultHistoryTokenRatio(
      overrides.history_token_ratio ?? model?.history_token_ratio
    ),
    modalities: defaultModalities(overrides.modalities || model?.modalities),
    model_params: modelParams,
    execution_params: executionParams,
    additional_params:
      overrides.additional_params && typeof overrides.additional_params === 'object'
        ? { ...overrides.additional_params }
        : model?.additional_params && typeof model.additional_params === 'object'
          ? { ...model.additional_params }
          : {}
  }
}
