/**
 * 图片缓存：给生成/编辑出的图片分配唯一 ID，供后续「继续编辑」引用。
 *
 * 为什么需要它：
 *   多模态/生图工具返回的是 base64 data URL。若把整串 base64 塞进工具结果的
 *   摘要里传给模型，上下文会立刻爆炸（一张 1MB 图 ≈ 数百万 token）。
 *   所以对模型只暴露一个短 ID（img_xxx），需要看图时再用 read_image 工具
 *   按 ID 取回。这样既保持了「生成 → 不满意 → 继续编辑」的连贯性，
 *   又不会让上下文失控。
 *
 * 存储：IndexedDB 的 image_cache 表。图片体积大，单独存表，不与会话事件混在一起。
 */
import { db } from './db.js'
import { nowIso } from '../common/time.js'

const STORE = 'image_cache'

/** 生成一个短而唯一的 ID */
export function createImageId() {
  const rand = Math.random().toString(36).slice(2, 10)
  return `img_${Date.now().toString(36)}${rand}`
}

/**
 * 缓存一张图片。
 * @param {object} input
 * @param {string} input.data_url  data URL 或直链
 * @param {string} [input.mime]
 * @param {string} [input.prompt]  生成/编辑用的提示词
 * @param {string} [input.action]  generate / edit
 * @param {string} [input.parent_id] 编辑时的源图 ID，用于追溯
 * @param {number} [input.session_id]
 * @param {string} [input.turn_id]  所属轮次，删除单轮时据此精确清理
 * @returns {Promise<object>} 缓存记录（含 id）
 */
export async function cacheImage(input = {}) {
  const record = {
    id: input.id || createImageId(),
    data_url: String(input.data_url || ''),
    mime: String(input.mime || 'image/png'),
    prompt: String(input.prompt || ''),
    // generate / edit / upload —— 三种来源要能区分，便于追溯与清理策略
    action: ['edit', 'upload'].includes(input.action) ? input.action : 'generate',
    parent_id: input.parent_id || null,
    session_id: input.session_id ?? null,
    turn_id: input.turn_id ? String(input.turn_id) : null,
    width: Number(input.width) || 0,
    height: Number(input.height) || 0,
    model: String(input.model || ''),
    created_at: nowIso(),
  }
  if (!record.data_url) throw new Error('图片数据为空，无法缓存')
  await db.put(STORE, record)
  return record
}

/** 按 ID 取图片 */
export async function getImage(id) {
  const key = String(id || '').trim()
  if (!key) return null
  return db.get(STORE, key)
}

/** 批量取（用于列表展示） */
export async function getImages(ids = []) {
  const out = []
  for (const id of ids) {
    const row = await getImage(id)
    if (row) out.push(row)
  }
  return out
}

/** 列出某会话下的图片，按时间倒序 */
export async function listSessionImages(sessionId) {
  const rows = await db.allByIndex(STORE, 'session_id', sessionId).catch(() => [])
  return rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
}

/**
 * 删除某轮的图片。
 * 轮次删除时调用——该轮生成/编辑/上传的图都归于这一轮。
 */
export async function deleteImagesByTurn(sessionId, turnId) {
  const sid = Number(sessionId)
  const tid = String(turnId || '')
  if (!Number.isFinite(sid) || !tid) return 0
  const rows = await db.allByIndex(STORE, 'session_id', sid).catch(() => [])
  const targets = rows.filter((r) => String(r.turn_id || '') === tid)
  if (!targets.length) return 0
  await db.bulkRemove(STORE, targets.map((r) => r.id)).catch(() => {})
  return targets.length
}

/** 删除整个会话的图片（删会话 / 清空会话时调用） */
export async function deleteImagesBySession(sessionId) {
  const sid = Number(sessionId)
  if (!Number.isFinite(sid)) return 0
  const rows = await db.allByIndex(STORE, 'session_id', sid).catch(() => [])
  if (!rows.length) return 0
  await db.bulkRemove(STORE, rows.map((r) => r.id)).catch(() => {})
  return rows.length
}

/** 删除一张图片 */
export async function deleteImage(id) {
  return db.remove(STORE, id)
}

/** 清理超过指定天数的图片，避免无限增长 */
export async function pruneImages({ maxAgeDays = 30 } = {}) {
  const rows = await db.all(STORE).catch(() => [])
  const cutoff = Date.now() - maxAgeDays * 24 * 3600 * 1000
  let removed = 0
  for (const row of rows) {
    const t = new Date(row.created_at).getTime()
    if (Number.isFinite(t) && t < cutoff) {
      await db.remove(STORE, row.id).catch(() => {})
      removed += 1
    }
  }
  return removed
}
