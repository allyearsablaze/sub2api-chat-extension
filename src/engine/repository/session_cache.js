/** localStorage mirror: session list + model snapshots only; no messages, credentials or images. */
export const SESSION_CACHE_KEY = 's2chat_session_cache_v1'
export function readSessionCache() {
  try {
    const value = JSON.parse(localStorage.getItem(SESSION_CACHE_KEY) || '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch (_) { return {} }
}
export function cacheSession(row) {
  if (!row?.id) return
  try {
    const rows = readSessionCache()
    rows[row.id] = JSON.parse(JSON.stringify(row))
    localStorage.setItem(SESSION_CACHE_KEY, JSON.stringify(rows))
  } catch (error) {
    // IndexedDB is the durable fallback if localStorage is full/disabled.
    console.warn('会话 localStorage 缓存写入失败', error?.name || '')
  }
}
export function removeCachedSession(id) {
  try {
    const rows = readSessionCache()
    delete rows[id]
    localStorage.setItem(SESSION_CACHE_KEY, JSON.stringify(rows))
  } catch (_) { /* IndexedDB deletion remains authoritative */ }
}
export function withCachedSnapshot(row) {
  if (!row) return row
  const cached = readSessionCache()[row.id]
  const a = cached?.model_snapshot
  const b = row.model_snapshot
  // Never apply one key/model's parameters to another model or resurrect deleted sessions.
  if (a && b && String(cached.provider_id) === String(row.provider_id)
    && String(cached.model_id) === String(row.model_id) && a.model_label === b.model_label
    && String(cached.updated_at) > String(row.updated_at)) {
    return { ...row, model_snapshot: a, updated_at: cached.updated_at }
  }
  return row
}
