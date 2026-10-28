import { db } from './db.js'
import { DEFAULT_CONFIG } from './schema.js'
import { clone, trimText } from '../common/json.js'

/** 读取全部配置项（默认值做深拷贝，避免调用方改到常量） */
export async function getConfigEntries() {
  const rows = await db.all('config')
  const map = clone(DEFAULT_CONFIG)
  for (const row of rows) map[row.key] = clone(row.value)
  return map
}

export async function getConfigValue(key, fallback = null) {
  const row = await db.get('config', key)
  return row ? row.value : fallback
}

export async function setConfigValue(key, value) {
  const name = trimText(key)
  if (!name) return false
  await db.put('config', { key: name, value })
  return true
}

export async function updateConfigEntries(entries = {}) {
  const payload = typeof entries === 'object' && entries ? entries : {}
  for (const [key, value] of Object.entries(payload)) {
    await setConfigValue(key, clone(value))
  }
  return getConfigEntries()
}
