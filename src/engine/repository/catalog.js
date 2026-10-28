import { db } from './db.js'
import { fail, ensure } from '../common/errors.js'
import { nowIso } from '../common/time.js'
import { clone, deepMerge, toNumberOrNull, trimText } from '../common/json.js'
import {
  defaultHistoryTokenRatio,
  defaultMaxHistoryMessages,
  defaultModalities,
  effectiveProviderApi,
  executionParamsWithDefaults,
  sanitizeModelParamsForApi
} from '../model/model_params.js'

const PROVIDER_KINDS = new Set(['openai', 'openai-compatible', 'anthropic'])

const PROVIDER_DEFAULTS = {
  openai: { base_url: 'https://api.openai.com/v1', api: '/chat/completions' },
  'openai-compatible': { base_url: '', api: '/chat/completions' },
  anthropic: { base_url: 'https://api.anthropic.com', api: '/v1/messages' }
}

export function normalizeProviderKind(kind) {
  const value = trimText(kind, 'openai').toLowerCase()
  if (value === 'openai_compatible' || value === 'compatible') return 'openai-compatible'
  return PROVIDER_KINDS.has(value) ? value : 'openai'
}

export function normalizeProvider(input = {}) {
  const kind = normalizeProviderKind(input.kind)
  const defaults = PROVIDER_DEFAULTS[kind]
  return {
    id: input.id ?? null,
    name: trimText(input.name),
    kind,
    api_key: trimText(input.api_key),
    base_url: trimText(input.base_url, defaults.base_url).replace(/\/+$/, ''),
    api: trimText(input.api, defaults.api),
    anthropic_version: trimText(input.anthropic_version, kind === 'anthropic' ? '2023-06-01' : ''),
    provider_config: input.provider_config && typeof input.provider_config === 'object' ? clone(input.provider_config) : {},
    enabled: input.enabled !== false,
    created_at: input.created_at || nowIso(),
    updated_at: nowIso()
  }
}

export function normalizeModel(input = {}) {
  const params = (value) => (value && typeof value === 'object' ? clone(value) : null)
  return {
    id: input.id ?? null,
    provider_id: toNumberOrNull(input.provider_id),
    alias: trimText(input.alias),
    model_id: trimText(input.model_id),
    display_name: trimText(input.display_name) || trimText(input.model_id),
    api: trimText(input.api),
    context_window: toNumberOrNull(input.context_window),
    history_token_ratio: toNumberOrNull(input.history_token_ratio),
    modalities: Array.isArray(input.modalities) && input.modalities.length ? [...input.modalities] : ['text'],
    model_params: params(input.model_params),
    execution_params: params(input.execution_params),
    additional_params: params(input.additional_params),
    enabled: input.enabled !== false,
    created_at: input.created_at || nowIso(),
    updated_at: nowIso()
  }
}

export async function listProviders() {
  const rows = await db.all('providers')
  return rows.sort((a, b) => a.id - b.id)
}

export async function getProvider(providerId) {
  const id = toNumberOrNull(providerId)
  if (id === null) return null
  return (await db.get('providers', id)) || null
}

export async function requireProvider(providerId) {
  const provider = await getProvider(providerId)
  ensure(provider, `供应商 #${providerId} 不存在`, 'PROVIDER_NOT_FOUND')
  return provider
}

export async function upsertProvider(input) {
  const record = normalizeProvider(input)
  ensure(record.name, '供应商名称不能为空', 'PROVIDER_NAME_REQUIRED')
  const existing = (await listProviders()).find(
    (item) => item.name === record.name && item.id !== record.id
  )
  ensure(!existing, `供应商名称「${record.name}」已存在`, 'PROVIDER_NAME_DUPLICATED')

  if (record.id) {
    const current = await requireProvider(record.id)
    const merged = { ...current, ...record, id: current.id, created_at: current.created_at }
    await db.put('providers', merged)
    return merged.id
  }
  const created = { ...record }
  delete created.id
  const id = await db.add('providers', created)
  return id
}

export async function deleteProvider(providerId) {
  const provider = await requireProvider(providerId)
  const models = await listModels()
  const owned = models.filter((model) => model.provider_id === provider.id)
  for (const model of owned) {
    await db.remove('models', model.id)
  }
  const agents = await db.all('agents')
  for (const agent of agents) {
    if (agent.provider_id === provider.id || owned.some((model) => model.id === agent.model_id)) {
      await db.put('agents', { ...agent, provider_id: null, model_id: null, updated_at: nowIso() })
    }
  }
  await db.remove('providers', provider.id)
  return { deleted_models: owned.length }
}

export async function listModels() {
  const rows = await db.all('models')
  return rows.sort((a, b) => a.id - b.id)
}

export async function getModel(modelId) {
  const id = toNumberOrNull(modelId)
  if (id === null) return null
  return (await db.get('models', id)) || null
}

export async function requireModel(modelId) {
  const model = await getModel(modelId)
  ensure(model, `模型 #${modelId} 不存在`, 'MODEL_NOT_FOUND')
  return model
}

export async function upsertModel(input) {
  const record = normalizeModel(input)
  ensure(record.alias, '模型别名（alias）不能为空', 'MODEL_ALIAS_REQUIRED')
  ensure(record.model_id, '模型 ID（model_id）不能为空', 'MODEL_ID_REQUIRED')
  ensure(record.provider_id !== null, '模型必须绑定供应商', 'MODEL_PROVIDER_REQUIRED')
  await requireProvider(record.provider_id)

  const rows = await listModels()
  const duplicated = rows.find(
    (item) => item.provider_id === record.provider_id && item.alias === record.alias && item.id !== record.id
  )
  ensure(!duplicated, `该供应商下已存在别名「${record.alias}」的模型`, 'MODEL_ALIAS_DUPLICATED')

  if (record.id) {
    const current = await requireModel(record.id)
    const merged = { ...current, ...record, id: current.id, created_at: current.created_at }
    await db.put('models', merged)
    return merged.id
  }
  const created = { ...record }
  delete created.id
  return db.add('models', created)
}

export async function deleteModel(modelId) {
  const model = await requireModel(modelId)
  const agents = await db.all('agents')
  for (const agent of agents) {
    if (agent.model_id === model.id) {
      await db.put('agents', { ...agent, model_id: null, updated_at: nowIso() })
    }
  }
  await db.remove('models', model.id)
  return true
}

export async function listPrompts() {
  const rows = await db.all('prompt_templates')
  return rows.sort((a, b) => a.id - b.id)
}

export async function getPrompt(promptId) {
  const id = toNumberOrNull(promptId)
  if (id === null) return null
  return (await db.get('prompt_templates', id)) || null
}

export async function upsertPrompt(input = {}) {
  const name = trimText(input.name)
  ensure(name, '提示词名称不能为空', 'PROMPT_NAME_REQUIRED')
  const record = {
    id: input.id ?? null,
    name,
    preamble: String(input.preamble || ''),
    created_at: input.created_at || nowIso(),
    updated_at: nowIso()
  }
  const rows = await listPrompts()
  const duplicated = rows.find((item) => item.name === name && item.id !== record.id)
  ensure(!duplicated, `提示词名称「${name}」已存在`, 'PROMPT_NAME_DUPLICATED')
  if (record.id) {
    const current = await db.get('prompt_templates', record.id)
    ensure(current, `提示词 #${record.id} 不存在`, 'PROMPT_NOT_FOUND')
    const merged = { ...current, ...record, created_at: current.created_at }
    await db.put('prompt_templates', merged)
    return merged.id
  }
  const created = { ...record }
  delete created.id
  return db.add('prompt_templates', created)
}

export async function deletePrompt(promptId) {
  const id = toNumberOrNull(promptId)
  ensure(id !== null, '提示词 ID 无效')
  const agents = await db.all('agents')
  for (const agent of agents) {
    if (agent.prompt_id === id) {
      await db.put('agents', { ...agent, prompt_id: null, updated_at: nowIso() })
    }
  }
  await db.remove('prompt_templates', id)
  return true
}

/**
 * 解析出可直接发起请求的模型配置。
 *
 * 参数优先级（后者覆盖前者）：
 *   协议缺省 → 模型记录 → 会话快照 → Agent 运行参数（仅 SubAgent 使用）→ 单次请求
 * 模型参数会按当前协议清洗，避免把 responses 不认识的键发给 chat/completions 之类的 400。
 */
export async function resolveModelConfig({ providerId, modelId, snapshot = null, overrides = {}, api = '' } = {}) {
  const provider = await requireProvider(providerId)
  const model = await requireModel(modelId)
  ensure(model.provider_id === provider.id, '模型与供应商不匹配', 'MODEL_PROVIDER_MISMATCH')
  ensure(provider.enabled, `供应商「${provider.name}」已停用`, 'PROVIDER_DISABLED')
  ensure(model.enabled, `模型「${model.alias}」已停用`, 'MODEL_DISABLED')

  const kind = provider.kind
  const compatible = kind === 'openai-compatible'
  /* 协议来源优先级：显式入参 > 会话快照 > 模型 > 供应商默认。
   * sub2api 是统一网关，同一把密钥可能访问 completions / responses / messages，
   * 所以必须让用户显式选择的协议生效。 */
  const protocol = effectiveProviderApi(
    kind,
    trimText(api || snapshot?.api || model.api || provider.api)
  )
  /**
   * api 表示协议（completions / responses / messages），api_path 才是实际请求路径。
   * 供应商里保存的默认路径在切换协议时要换成该协议的默认值，避免把 /chat/completions 发给 responses。
   */
  const defaultPath =
    protocol === 'responses' ? '/responses' : protocol === 'messages' ? '/v1/messages' : '/chat/completions'
  const configuredPath = trimText(provider.api)
  const isDefaultPath =
    !configuredPath ||
    configuredPath === '/chat/completions' ||
    configuredPath === '/completions' ||
    configuredPath === '/responses' ||
    configuredPath === '/v1/messages'
  const apiPath = isDefaultPath ? defaultPath : configuredPath
  const mergedModelParams = deepMerge(
    deepMerge(model.model_params || {}, snapshot?.model_params || {}),
    overrides.model_params || {}
  )
  const modelParams = sanitizeModelParamsForApi(kind, protocol, mergedModelParams, compatible)
  const executionParams = executionParamsWithDefaults(
    deepMerge(deepMerge(model.execution_params || {}, snapshot?.execution_params || {}), overrides.execution_params || {})
  )
  const additionalParams = deepMerge(
    deepMerge(model.additional_params || {}, snapshot?.additional_params || {}),
    overrides.additional_params || {}
  )

  return {
    provider,
    model,
    kind,
    api: protocol,
    api_path: apiPath,
    base_url: provider.base_url,
    api_key: provider.api_key,
    anthropic_version: provider.anthropic_version,
    context_window:
      toNumberOrNull(overrides.context_window) ??
      toNumberOrNull(snapshot?.context_window) ??
      model.context_window,
    max_history_messages:
      toNumberOrNull(overrides.max_history_messages) ??
      toNumberOrNull(snapshot?.max_history_messages) ??
      defaultMaxHistoryMessages(undefined),
    history_token_ratio: defaultHistoryTokenRatio(
      overrides.history_token_ratio ?? snapshot?.history_token_ratio ?? model.history_token_ratio
    ),
    modalities: defaultModalities(overrides.modalities || snapshot?.modalities || model.modalities),
    model_params: modelParams,
    execution_params: executionParams,
    additional_params: additionalParams,
    provider_config: provider.provider_config || {}
  }
}

export async function fetchRemoteModels(providerId) {
  const provider = await requireProvider(providerId)
  ensure(provider.api_key, '供应商未配置 API Key，无法拉取模型列表', 'PROVIDER_KEY_MISSING')
  const base = provider.base_url.replace(/\/+$/, '')
  const url = provider.kind === 'anthropic' ? `${base}/v1/models` : `${base}/models`
  const headers = provider.kind === 'anthropic'
    ? { 'x-api-key': provider.api_key, 'anthropic-version': provider.anthropic_version || '2023-06-01' }
    : { Authorization: `Bearer ${provider.api_key}` }
  const response = await fetch(url, { headers })
  if (!response.ok) {
    fail(`拉取模型列表失败（HTTP ${response.status}）：${(await response.text()).slice(0, 300)}`, 'REMOTE_MODELS_FAILED')
  }
  const payload = await response.json()
  const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : []
  return rows.map((item) => ({
    id: item.id || item.model_id || item.name,
    display_name: item.display_name || item.name || item.id,
    created: item.created || null
  }))
}
