/**
 * edit_image / read_image：图片编辑与回读。
 *
 * 设计要点：
 *   1. 生成/编辑出的图片先落 image_cache，只把短 ID（img_xxx）交给模型。
 *      模型想「继续编辑上一张」时用这个 ID 引用，无需携带 base64。
 *   2. read_image 按 ID 取回图片并转成 base64，供模型真正「看到」图
 *      （多模态输入）。是否注册由「输入模态是否包含图片」决定。
 *   3. /v1/images/edits 走 multipart：单图用 image，多图按顺序重复 image[]，
 *      mask 只作用于第一张。
 */
import { toolRegistry, jsonSchema, schemaTypes as t } from './registry.js'
import { AppError } from '../../common/errors.js'
import { getImage, cacheImage } from '../../repository/image_cache.js'
import { imageExtension, resolveImageResults } from '../../common/image.js'
import { buildImageOptions, imageCapabilities, requireImageConfig } from './image_options.js'
import {
  platformSupportsImage, GEMINI_IMAGE_PLATFORMS
} from './image.js'

const EDIT_IMAGE_ID = /^img_[a-z0-9]+$/

/** data URL → { mime, bytes } */
function parseDataUrl(dataUrl) {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(String(dataUrl || ''))
  if (!m) return null
  const bin = atob(m[2])
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
  return { mime: m[1], bytes }
}


async function readError(resp) {
  try {
    const text = await resp.text()
    try {
      const j = JSON.parse(text)
      return (j.error && (j.error.message || j.error.type)) || j.message || text.slice(0, 300)
    } catch (_) {
      return text.slice(0, 300) || `HTTP ${resp.status}`
    }
  } catch (_) {
    return `HTTP ${resp.status}`
  }
}

/** 解析 image 参数：既支持缓存 ID，也支持 data URL / http 直链 */
async function resolveSourceImage(ref) {
  const raw = String(ref || '').trim()
  if (!raw) throw new AppError('image 不能为空：需要图片 ID（img_xxx）或 data URL', 'IMAGE_EMPTY_SOURCE')

  // 缓存 ID
  if (/^img_[a-z0-9]+$/i.test(raw)) {
    const row = await getImage(raw)
    if (!row) throw new AppError(`找不到图片 ${raw}，可能已过期清理`, 'IMAGE_NOT_FOUND')
    return { dataUrl: row.data_url, mime: row.mime, record: row }
  }

  // data URL
  if (raw.startsWith('data:')) {
    return { dataUrl: raw, mime: (parseDataUrl(raw) || {}).mime || 'image/png', record: null }
  }

  // 直链：抓回二进制
  if (/^https?:\/\//i.test(raw)) {
    const resp = await fetch(raw)
    if (!resp.ok) throw new AppError(`下载源图失败：HTTP ${resp.status}`, 'IMAGE_FETCH_FAILED')
    const blob = await resp.blob()
    const buf = new Uint8Array(await blob.arrayBuffer())
    let bin = ''
    for (let i = 0; i < buf.length; i += 1) bin += String.fromCharCode(buf[i])
    const b64 = btoa(bin)
    const mime = blob.type || 'image/png'
    return { dataUrl: `data:${mime};base64,${b64}`, mime, record: null }
  }

  throw new AppError('image 格式无法识别：需要 img_xxx ID、data URL 或 http 链接', 'IMAGE_BAD_SOURCE')
}

/**
 * 编辑图片。
 * ctx.imageConfig 提供生图分组与密钥，与对话密钥解耦。
 */
export async function runImageEdit(args, ctx = {}) {
  const { apiKey, platform, model } = requireImageConfig(ctx)
  if (!platformSupportsImage(platform)) {
    throw new AppError(`平台「${platform}」不支持图片编辑`, 'IMAGE_PLATFORM_UNSUPPORTED')
  }

  const prompt = String(args.prompt || '').trim()
  if (!prompt) throw new AppError('prompt 不能为空，需要说明要改什么', 'IMAGE_EMPTY_PROMPT')

  if (GEMINI_IMAGE_PLATFORMS.has(platform)) {
    throw new AppError(
      'Gemini 通道暂不支持图生图编辑，请改用 OpenAI / Grok 生图分组',
      'IMAGE_EDIT_UNSUPPORTED_PLATFORM'
    )
  }

  const { maxEditImages } = imageCapabilities({ model, platform })
  const sourceIds = args.images
  if (!Array.isArray(sourceIds) || !sourceIds.length || sourceIds.length > maxEditImages) {
    throw new AppError(`images 必须是包含 1 至 ${maxEditImages} 个图片 ID 的有序数组`, 'IMAGE_BAD_SOURCES')
  }
  if (!sourceIds.every((id) => typeof id === 'string' && EDIT_IMAGE_ID.test(id))) {
    throw new AppError('images 中每一项都必须是已有图片的 ID（img_xxx）', 'IMAGE_BAD_SOURCE')
  }

  const base = String(ctx.baseUrl || '').replace(/\/+$/, '')
  const options = buildImageOptions(args, { model, platform })
  const started = Date.now()

  const form = new FormData()
  form.append('model', model)
  form.append('prompt', prompt)
  for (const [key, value] of Object.entries(options)) {
    form.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value))
  }
  if (args.n) form.append('n', String(Math.min(Math.max(Number(args.n) || 1, 1), 4)))
  if (args.size) form.append('size', String(args.size))

  const imageField = sourceIds.length === 1 ? 'image' : 'image[]'
  for (const [index, id] of sourceIds.entries()) {
    const source = await getImage(id)
    if (!source) throw new AppError(`找不到第 ${index + 1} 张图片 ${id}，可能已过期清理`, 'IMAGE_NOT_FOUND')
    const parsed = parseDataUrl(source.data_url)
    if (!parsed) throw new AppError(`第 ${index + 1} 张源图 ${id} 不是有效的 data URL`, 'IMAGE_BAD_SOURCE')
    const blob = new Blob([parsed.bytes], { type: parsed.mime })
    const filename = sourceIds.length === 1 ? 'source' : `source-${index + 1}`
    form.append(imageField, blob, `${filename}.${imageExtension(parsed.mime)}`)
  }

  // 局部重绘：只作用于第一张图，mask 必须是同尺寸且带透明通道的 PNG。
  if (args.mask !== undefined) {
    const mask = parseDataUrl(args.mask)
    if (mask?.mime !== 'image/png') throw new AppError('遮罩必须是 PNG data URL，尺寸须与第一张图片一致', 'IMAGE_BAD_MASK')
    form.append('mask', new Blob([mask.bytes], { type: mask.mime }), 'mask.png')
  }

  const resp = await fetch(`${base}/v1/images/edits`, {
    method: 'POST',
    signal: ctx.signal,
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  })
  if (!resp.ok) throw new AppError(await readError(resp), 'IMAGE_EDIT_FAILED')

  const json = await resp.json()
  if (json.error) throw new AppError(json.error.message || '图片编辑失败', 'IMAGE_UPSTREAM_ERROR')

  const images = await resolveImageResults(json, options.output_format, ctx.signal)
  if (!images.length) throw new AppError('上游未返回编辑结果', 'IMAGE_EMPTY_RESULT')

  /* 与 generate_image 一致：写缓存并只返回短 ID。
   * parent_id 记录第一张图，保留原有主图迭代链路。 */
  const cached = []
  for (const img of images) {
    const dataUrl = img.data_url || img.url || ''
    if (!dataUrl) continue
    try {
      const row = await cacheImage({
        data_url: dataUrl,
        mime: img.mime || 'image/png',
        prompt,
        action: 'edit',
        parent_id: sourceIds[0],
        session_id: ctx.sessionId ?? null,
        turn_id: ctx.turnId ?? null,
        model,
      })
      cached.push({ id: row.id, mime: row.mime, bytes: Math.round((dataUrl.length * 3) / 4) })
    } catch (_) {
      cached.push({ mime: img.mime || 'image/png', data_url: dataUrl })
    }
  }

  return {
    ok: true,
    model,
    platform,
    source_id: sourceIds[0],
    source_ids: sourceIds,
    images: cached.length ? cached : images,
    warnings: images.map((image) => image.format_warning).filter(Boolean),
    elapsed_ms: Date.now() - started,
  }
}

/**
 * 读取图片为 base64。
 * 返回 data_url，模型据此真正「看到」图片内容（多模态）。
 */
export async function runImageRead(args) {
  const source = await resolveSourceImage(args.image)
  const parsed = parseDataUrl(source.dataUrl)
  if (!parsed) throw new AppError('图片数据无效', 'IMAGE_BAD_SOURCE')
  return {
    ok: true,
    id: source.record?.id || null,
    mime: parsed.mime,
    bytes: parsed.bytes.length,
    data_url: source.dataUrl,
    prompt: source.record?.prompt || '',
    action: source.record?.action || '',
    parent_id: source.record?.parent_id || null,
    created_at: source.record?.created_at || '',
  }
}

const editImageTool = {
  name: 'edit_image',
  category: 'image',
  risk: 'medium',
  readOnly: false,
  /* 图生图要上传原图 + 重绘，通常比纯生图更慢 */
  timeoutMs: 240000,
  description:
    '用 images 按顺序传入已上传或生成的图片 ID，第一张是主图，后续图片是参考素材。' +
    'prompt 应说明要改什么；合成时请按第几张图分别说明用途。' +
    'mask 仅作用于第一张图。注意：会产生费用。',
  handler: async (args, ctx = {}) => runImageEdit(args, ctx)
}

const readImageTool = {
  name: 'read_image',
  category: 'image',
  risk: 'low',
  readOnly: true,
  description:
    '按图片 ID 读取图片内容，返回 base64 data URL。' +
    '当用户引用之前生成/编辑过的图片、需要你判断画面细节时使用。' +
    '读取后你就能看到这张图，可以据此给出改进建议或决定下一步编辑。',
  parameters: jsonSchema(
    { image: t.string('图片 ID（img_xxx），或 data URL / http 链接') },
    ['image']
  ),
  handler: async (args, ctx = {}) => runImageRead(args, ctx)
}

export function registerImageEditTool(config) {
  const capability = imageCapabilities(config)
  if (!capability.supportsEdit) {
    unregisterImageEditTool()
    return toolRegistry
  }
  toolRegistry.register({
    ...editImageTool,
    description: `编辑图片${capability.maxEditImages > 1 ? '或合成多张图片' : ''}。` + editImageTool.description + capability.description,
    parameters: jsonSchema({
      images: t.array('依次提供图片 ID，第一张是主图；单图也使用数组', t.string('已上传或生成的图片 ID', { pattern: EDIT_IMAGE_ID.source }), {
        minItems: 1,
        maxItems: capability.maxEditImages,
      }),
      prompt: t.string('编辑指令：说明要改什么、改成什么样'),
      mask: t.string('可选。与第一张图同尺寸的 PNG 遮罩 data URL，透明区域会被重绘'),
      ...capability.properties,
    }, ['images', 'prompt']),
  })
  return toolRegistry
}

export function unregisterImageEditTool() {
  toolRegistry.tools.delete('edit_image')
}

export function registerImageReadTool() {
  if (!toolRegistry.has('read_image')) toolRegistry.register(readImageTool)
  return toolRegistry
}

export function unregisterImageReadTool() {
  toolRegistry.tools.delete('read_image')
}
