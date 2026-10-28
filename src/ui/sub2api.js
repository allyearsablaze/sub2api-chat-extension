/**
 * Sub2API 会话桥。
 *
 * 职责：把 sub2api 面板 API 的「密钥 / 分组」转化为引擎需要的「供应商 / 模型」。
 *
 * 关键约束（均经后端源码核对）：
 *   - JWT 存在 localStorage['auth_token']，也接受 ?token= 传参（iframe 场景）。
 *   - GET /api/v1/keys 返回的 items[].key 是**明文**，无需二次解密。
 *   - 平台挂在分组上，不在密钥上，所以要 join /api/v1/groups/available。
 *   - 平台 → 网关族严格对齐 backend/internal/domain/platforms.go。
 */

const GW_OPENAI = new Set([
  'openai', 'grok', 'kimi', 'zhipu', 'deepseek', 'minimax',
  'opencode_go', 'command_code', 'cline'
])
const GW_ANTHROPIC = new Set(['anthropic', 'typesafe'])
const GW_GEMINI = new Set(['gemini', 'antigravity'])

export const PLATFORM_LABEL = {
  openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Gemini', antigravity: 'Antigravity',
  grok: 'Grok', kimi: 'Kimi', zhipu: '智谱 GLM', deepseek: 'DeepSeek', minimax: 'MiniMax',
  opencode_go: 'OpenCode', typesafe: 'TypeSafe', command_code: 'Command Code',
  cline: 'Cline', composite: '组合'
}

export function gatewayOf(platform) {
  if (GW_ANTHROPIC.has(platform)) return 'anthropic'
  if (GW_GEMINI.has(platform)) return 'gemini'
  return 'openai'
}

export function readToken() {
  try {
    const t = new URLSearchParams(location.search).get('token')
    if (t) return t
  } catch (_) { /* ignore */ }
  try { return localStorage.getItem('auth_token') } catch (_) { return null }
}

async function apiFetch(path, { token, signal } = {}) {
  const res = await fetch(`/api/v1${path}`, {
    signal,
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  })
  if (res.status === 401) {
    const err = new Error('登录已过期，请回到主站刷新页面后重试')
    err.code = 401
    throw err
  }
  let body = null
  const text = await res.text()
  try { body = text ? JSON.parse(text) : null } catch (_) { body = null }
  if (!res.ok) {
    const err = new Error((body && (body.message || body.error)) || `HTTP ${res.status}`)
    err.code = res.status
    throw err
  }
  if (body && typeof body === 'object' && 'code' in body) {
    if (body.code !== 0) {
      const err = new Error(body.message || '接口返回错误')
      err.code = body.code
      throw err
    }
    return body.data
  }
  return body
}

/**
 * 拉取用户的密钥列表，并 join 分组信息。
 * 返回的每一项都是一个可直接对话的「频道」。
 */
export async function loadChannels({ token, signal } = {}) {
  const [groupList, keyPage] = await Promise.all([
    apiFetch('/groups/available', { token, signal }),
    apiFetch('/keys?page=1&page_size=1000', { token, signal }).catch(() => ({ items: [] }))
  ])

  const groupById = new Map()
  for (const g of Array.isArray(groupList) ? groupList : []) {
    groupById.set(Number(g.id), g)
  }

  const channels = []
  for (const k of (keyPage && keyPage.items) || []) {
    if (!k || !k.key) continue
    // 只保留 active 状态的密钥（后端也可能返回 inactive）
    if (k.status && k.status !== 'active') continue
    const gid = k.group_id ? Number(k.group_id) : null
    const group = gid ? groupById.get(gid) : null
    channels.push({
      keyId: k.id,
      keyName: k.name || `密钥 #${k.id}`,
      apiKey: k.key,
      groupId: gid,
      groupName: group ? group.name : (gid ? `分组 #${gid}` : '未分组'),
      platform: group ? group.platform : '',
      platformLabel: group ? (PLATFORM_LABEL[group.platform] || group.platform) : '未知',
      gateway: group ? gatewayOf(group.platform) : 'openai',
      rateMultiplier: group ? Number(group.rate_multiplier || 0) : 0,
      allowImageGeneration: group ? !!group.allow_image_generation : false,
      claudeCodeOnly: group ? !!group.claude_code_only : false,
      isExclusive: group ? !!group.is_exclusive : false,
      subscriptionType: group ? group.subscription_type : '',
      quota: Number(k.quota || 0),
      quotaUsed: Number(k.quota_used || 0),
    })
  }
  return channels
}

/**
 * 用某个密钥拉取可用模型。
 * 响应格式随平台不同，这里统一归一化为字符串数组。
 */
export async function fetchModels(channel, { signal } = {}) {
  const gw = channel.gateway
  const url = gw === 'gemini' ? '/v1beta/models' : '/v1/models'
  const headers = { Authorization: `Bearer ${channel.apiKey}` }
  if (gw === 'anthropic') headers['anthropic-version'] = '2023-06-01'

  const res = await fetch(url, { headers, signal })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    // 401/403 说明密钥不可用；其他错误也如实抛出，便于界面提示
    let msg = `HTTP ${res.status}`
    try {
      const j = JSON.parse(text)
      msg = (j.error && (j.error.message || j.error.type)) || j.message || msg
    } catch (_) {
      if (text) msg = text.slice(0, 200)
    }
    const err = new Error(msg)
    err.status = res.status
    throw err
  }

  const json = await res.json()
  let ids = []
  if (Array.isArray(json.data)) {
    ids = json.data.map((m) => (typeof m === 'string' ? m : (m.id || m.name))).filter(Boolean)
  } else if (Array.isArray(json.models)) {
    ids = json.models
      .map((m) => String(m.name || m.id || '').replace(/^models\//, ''))
      .filter(Boolean)
  } else if (Array.isArray(json)) {
    ids = json.map((m) => (typeof m === 'string' ? m : (m.id || m.name))).filter(Boolean)
  }

  return Array.from(new Set(ids))
}
