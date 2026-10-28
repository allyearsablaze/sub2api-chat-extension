/**
 * 本地设置：生图使用的分组与模型。
 *
 * 需求：设置项里可以指定「生图用哪个分组 + 哪个模型」。
 * 若未配置（或配置的分组不可用），就不注册 generate_image 工具。
 *
 * 存储：localStorage（不入 IndexedDB，避免与会话数据混在一起）
 */
const KEY = 's2chat_settings'

const DEFAULTS = {
  imageGroupId: null,     // sub2api 分组 id
  imageModel: '',         // 生图模型名
  systemPrompt: '',       // 全局系统提示词，所有模型共享
  lastSessionId: null,    // 上次打开的会话，刷新后自动恢复
}

export function loadSettings() {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULTS }
    const parsed = JSON.parse(raw)
    return {
      imageGroupId: parsed.imageGroupId ?? null,
      imageModel: typeof parsed.imageModel === 'string' ? parsed.imageModel : '',
      systemPrompt: typeof parsed.systemPrompt === 'string' ? parsed.systemPrompt : '',
      lastSessionId: Number.isFinite(Number(parsed.lastSessionId)) ? Number(parsed.lastSessionId) : null,
    }
  } catch (_) {
    return { ...DEFAULTS }
  }
}

export function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch }
  try { localStorage.setItem(KEY, JSON.stringify(next)) } catch (_) {}
  return next
}

export function clearSettings() {
  try { localStorage.removeItem(KEY) } catch (_) {}
  return { ...DEFAULTS }
}

export { DEFAULTS as DEFAULT_SETTINGS }
