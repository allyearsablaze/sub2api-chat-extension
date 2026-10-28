export function clone(value) {
  if (value === undefined) return undefined
  if (value === null) return null
  return JSON.parse(JSON.stringify(value))
}

export function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(text)
  } catch (_error) {
    return fallback
  }
}

export function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** 深度合并：overlay 覆盖 base，数组与标量直接替换 */
export function deepMerge(base, overlay) {
  if (!isPlainObject(base)) return clone(overlay)
  if (!isPlainObject(overlay)) return clone(overlay === undefined ? base : overlay)
  const result = clone(base)
  for (const [key, value] of Object.entries(overlay)) {
    if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = deepMerge(result[key], value)
    } else {
      result[key] = clone(value)
    }
  }
  return result
}

export function pickDefined(target, source) {
  for (const [key, value] of Object.entries(source || {})) {
    if (value !== undefined) target[key] = value
  }
  return target
}

export function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

export function toBool(value, fallback = false) {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  const text = String(value).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(text)) return true
  if (['0', 'false', 'no', 'off', 'disabled'].includes(text)) return false
  return fallback
}

export function trimText(value, fallback = '') {
  if (value === null || value === undefined) return fallback
  return String(value).trim()
}
