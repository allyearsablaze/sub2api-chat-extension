/**
 * 引擎装配：把 sub2api 的「密钥 / 分组 / 模型」桥接成引擎的「供应商 / 模型 / 会话」。
 *
 * 关键约束（均经源码核对）：
 *   - provider.base_url 留空 → 请求走同源相对路径（/v1、/v1beta），
 *     部署在 Caddy 同域下时无需任何跨域配置。
 *   - IndexedDB 的 provider.id / model.id 是自增数字，sub2api 的 keyId 存在
 *     provider_config.key_id 里，用于「同一个密钥复用同一个 provider」。
 *   - 生图工具按平台动态注册/注销。
 */
import {
  listProviders, upsertProvider, deleteProvider,
  listModels, upsertModel, deleteModel
} from '../engine/repository/catalog.js'
import {
  createSession, listSessions, getSession, deleteSession,
  listEvents, clearSessionHistory, deleteTurn as removeTurn, updateSession
} from '../engine/repository/session.js'
import { runSessionTurn } from '../engine/runtime/agent_executor.js'
import { toEventVo } from '../engine/repository/event_vo.js'
import { listEvents as listRawEvents } from '../engine/repository/session.js'
import { getConfigEntries, getConfigValue, setConfigValue } from '../engine/repository/config.js'
import { registerBuiltinTools, toolRegistry } from '../engine/runtime/tools/index.js'
import {
  registerImageTool, unregisterImageTool,
  platformSupportsImage, channelSupportsImage, pickImageModels
} from '../engine/runtime/tools/image.js'
import {
  registerImageEditTool, unregisterImageEditTool,
  registerImageReadTool, unregisterImageReadTool
} from '../engine/runtime/tools/image_edit.js'
import { visibleToolNames } from '../engine/runtime/tools/policy.js'

registerBuiltinTools()

const BASE_TOOLS = [
  'web_fetch', 'regex_extract', 'jsonpath_query', 'hash_digest',
  'jwt_decode', 'url_encode', 'url_decode', 'encoding_convert',
  'random_uuid', 'random_string', 'random_number'
]

/** 找到（或创建）某个 sub2api 密钥对应的 provider */
async function findProviderByKeyId(keyId) {
  const providers = await listProviders()
  return providers.find((p) => Number(p.provider_config?.key_id) === Number(keyId)) || null
}

/**
 * 确保某密钥对应的 provider 与 model 已落库。
 * 返回 { providerId, modelId } —— 都是本地自增数字 ID。
 */
export async function ensureProviderModel(channel, modelName) {
  const kind = channel.gateway === 'anthropic' ? 'anthropic' : 'openai-compatible'
  const label = `${channel.keyName} · ${channel.groupName}`

  /* base_url 与 api 的写法决定了「切换协议能否换对路径」。
   *
   * catalog.resolveModelConfig 用 isDefaultPath 白名单判断 provider.api 是不是
   * 协议默认路径；只有命中白名单才会按当前协议替换成对应路径。
   * 如果把 provider.api 写死成 '/v1/chat/completions'，它不在白名单里，
   * 用户切到 responses 时请求仍会发到 chat/completions → 400。
   *
   * 正确做法：
   *   openai 族 → base_url '/v1' + api '/chat/completions'
   *               joinUrl('/v1','/chat/completions') = '/v1/chat/completions'
   *               切 responses → '/v1' + '/responses' = '/v1/responses'
   *   anthropic → base_url '' + api '/v1/messages'
   */
  const isAnthropic = channel.gateway === 'anthropic'
  const providerPayload = {
    name: label,
    kind,
    base_url: isAnthropic ? '' : '/v1',
    api_key: channel.apiKey,
    api: isAnthropic ? '/v1/messages' : '/chat/completions',
    anthropic_version: '2023-06-01',
    enabled: true,
    provider_config: {
      key_id: channel.keyId,
      group_id: channel.groupId,
      platform: channel.platform,
    },
  }

  const existing = await findProviderByKeyId(channel.keyId)
  // 注意：upsertProvider / upsertModel 返回的是「主键 id」，不是对象
  const providerId = existing
    ? await upsertProvider({ ...providerPayload, id: existing.id, created_at: existing.created_at })
    : await upsertProvider(providerPayload)

  // 模型：同一 provider 下按 model_id 复用
  const models = await listModels()
  const existingModel = models.find(
    (m) => Number(m.provider_id) === Number(providerId) && m.model_id === modelName
  )
  const modelId = existingModel
    ? existingModel.id
    : await upsertModel({
        provider_id: providerId,
        model_id: modelName,
        alias: modelName,
        display_name: modelName,
        enabled: true,
        context_window: 128000,
        model_params: {},
        execution_params: { max_tool_call_rounds: 8, max_retries: 2 },
      })

  return { providerId, modelId }
}

/** 清理已不存在的密钥对应的 provider 及其模型 */
export async function pruneOrphanProviders(validKeyIds) {
  const valid = new Set(validKeyIds.map(Number))
  const providers = await listProviders()
  const models = await listModels()
  for (const p of providers) {
    const keyId = Number(p.provider_config?.key_id)
    if (!keyId) continue                      // 非本页创建的 provider，不动
    if (valid.has(keyId)) continue
    for (const m of models) {
      if (Number(m.provider_id) === Number(p.id)) await deleteModel(m.id).catch(() => {})
    }
    await deleteProvider(p.id).catch(() => {})
  }
}

/**
 * 当前密钥下应下发的工具名。
 *
 * 生图工具注册条件（两者都要满足，对齐后端双校验）：
 *   1. 平台支持：openai / grok / gemini / antigravity
 *   2. 分组开启：/groups/available 返回的 allow_image_generation === true
 */
/**
 * 计算当前应下发的工具名。
 *
 * 注意：这个函数**有副作用**（注册/注销 generate_image）。
 * 之所以必须有副作用，是因为 tool_loop 执行工具时会从 toolRegistry 取 handler，
 * 只改「下发的工具名数组」而不注册，模型调用时会得到「未知工具」。
 * 因此所有调用点都必须传同一个 imageConfig，否则会出现
 * 「A 处注册了、B 处又注销了」的竞态。
 */
export function resolveToolNames(channel, {
  includeAdmin = false,
  imageConfig = null,
  modalities = null,       // 会话配置的输入模态；null 表示未配置
} = {}) {
  /* 生图工具注册条件：
   *   1. 设置页已配置生图分组与模型
   *   2. 该分组的平台支持生图（openai / grok / gemini / antigravity）
   *   3. 该分组开启了 allow_image_generation
   *
   * 关键：判断依据是「设置里配置的生图分组」，不是当前对话所用的密钥。
   * 生图走自己的分组与密钥，与对话密钥完全解耦——用户在 deepseek 分组里聊天，
   * 也可以让它调用 GPT 分组的生图能力。
   * 旧的写法错在拿对话密钥的平台做判断，导致 deepseek 分组下永远没有生图工具。 */
  const configured = !!(imageConfig && imageConfig.groupId && imageConfig.model)
  const platformOk = configured && platformSupportsImage(imageConfig.platform)
  const supportsImage = configured && platformOk

  // 能生图 → 同时提供生成与编辑（编辑依赖生图分组，能力天然成对）
  if (supportsImage) {
    registerImageTool()
    registerImageEditTool()
  } else {
    unregisterImageTool()
    unregisterImageEditTool()
  }

  /* 读图工具：只有会话的输入模态包含 image 时才注册。
   * 纯文本模型读不了图，注册了只会让模型白调一次。 */
  const list = Array.isArray(modalities) && modalities.length ? modalities : ['text']
  const supportsVision = list.includes('image')
  if (supportsVision) registerImageReadTool()
  else unregisterImageReadTool()

  const candidates = [...BASE_TOOLS]
  if (supportsImage) candidates.push('generate_image', 'edit_image')
  if (supportsVision) candidates.push('read_image')

  return visibleToolNames({ candidateNames: candidates, includeAdmin })
}

/** 新建一个会话（多会话：每次新建，不复用） */
export async function createChatSession(channel, modelName, title = '') {
  const { providerId, modelId } = await ensureProviderModel(channel, modelName)

  // 注意：createSession 返回的是新增记录的 id，需要再取一次完整对象。
  // model_snapshot 必须给出完整字段：后续 updateSessionSnapshot 以它为 base 做局部更新，
  // 空对象会让 provider_id / model_id 被抹成 null。
  const api = channel.gateway === 'anthropic' ? 'messages' : 'completions'
  const newId = await createSession({
    title: title || `${channel.groupName} / ${modelName}`,
    provider_id: providerId,
    model_id: modelId,
    api,
    model_snapshot: {
      provider_id: providerId,
      model_id: modelId,
      provider_kind: channel.gateway === 'anthropic' ? 'anthropic' : 'openai',
      provider_label: `${channel.keyName} · ${channel.groupName}`,
      model_label: modelName,
      api,
    },
  })
  return getSession(newId)
}

/**
 * 切换会话使用的模型。
 *
 * 会话的 provider_id / model_id 决定后续每一轮请求发什么模型，
 * 所以下拉框切换后必须写回 session，否则请求仍用旧模型。
 */
export async function switchSessionModel(channel, sessionId, modelName) {
  const { providerId, modelId } = await ensureProviderModel(channel, modelName)
  const api = channel.gateway === 'anthropic' ? 'messages' : 'completions'
  return updateSession(sessionId, {
    provider_id: providerId,
    model_id: modelId,
    api,
    model_snapshot: {
      provider_id: providerId,
      model_id: modelId,
      provider_kind: channel.gateway === 'anthropic' ? 'anthropic' : 'openai',
      provider_label: `${channel.keyName} · ${channel.groupName}`,
      model_label: modelName,
      api,
    },
  })
}

/**
 * 读取会话事件并转成前端 VO。
 *
 * 关键：实时推送走 toEventVo（扁平结构：event.content / event.attachments），
 * 而 listEvents 返回的是原始行（内容藏在 event.context 里）。
 * 两者结构不同——历史加载若不转 VO，时间线就读不到正文，
 * 表现为「刷新后回复内容消失」。
 */
export async function listEventVos(sessionId) {
  const rows = await listRawEvents(sessionId)
  return rows.map((row) => toEventVo(row)).filter(Boolean)
}

export {
  updateSession,
  runSessionTurn,
  listSessions,
  getSession,
  deleteSession,
  listEvents,
  clearSessionHistory,
  removeTurn,
  platformSupportsImage,
  channelSupportsImage,
  pickImageModels,
  registerImageTool,
  registerImageEditTool,
  registerImageReadTool,
  toolRegistry,
  getConfigValue,
  setConfigValue,
  getConfigEntries,
}
