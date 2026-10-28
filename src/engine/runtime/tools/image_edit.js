/**
 * edit_image / read_image：图片编辑与回读。
 *
 * 设计要点：
 *   1. 生成/编辑出的图片先落 image_cache，只把短 ID（img_xxx）交给模型。
 *      模型想「继续编辑上一张」时用这个 ID 引用，无需携带 base64。
 *   2. read_image 按 ID 取回图片并转成 base64，供模型真正「看到」图
 *      （多模态输入）。是否注册由「输入模态是否包含图片」决定。
 *   3. 后端 /v1/images/edits 走 multipart，字段名 image（可 image[]），
 *      另支持 mask（局部重绘）。
 */
import { toolRegistry, jsonSchema, schemaTypes as t } from './registry.js'
import { AppError } from '../../common/errors.js'
import { getImage, cacheImage } from '../../repository/image_cache.js'
import {
  platformSupportsImage, GEMINI_IMAGE_PLATFORMS
} from './image.js'

/** data URL → { mime, bytes } */
function parseDataUrl(dataUrl) {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(String(dataUrl || ''))
  if (!m) return null
  const bin = atob(m[2])
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
  return { mime: m[1], bytes }
}

function extOf(mime) {
  const m = String(mime || 'image/png').toLowerCase()
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg'
  if (m.includes('webp')) return 'webp'
  return 'png'
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
  const cfg = ctx.imageConfig && ctx.imageConfig.apiKey ? ctx.imageConfig : null
  const apiKey = cfg ? cfg.apiKey : ctx.apiKey
  const platform = cfg ? cfg.platform : (ctx.platform || '')

  if (!apiKey) throw new AppError('生图密钥不可用，请在设置中配置生图分组', 'IMAGE_NO_KEY')
  if (!platformSupportsImage(platform)) {
    throw new AppError(`平台「${platform}」不支持图片编辑`, 'IMAGE_PLATFORM_UNSUPPORTED')
  }

  const prompt = String(args.prompt || '').trim()
  if (!prompt) throw new AppError('prompt 不能为空，需要说明要改什么', 'IMAGE_EMPTY_PROMPT')

  const source = await resolveSourceImage(args.image)
  if (GEMINI_IMAGE_PLATFORMS.has(platform)) {
    throw new AppError(
      'Gemini 通道暂不支持图生图编辑，请改用 OpenAI / Grok 生图分组',
      'IMAGE_EDIT_UNSUPPORTED_PLATFORM'
    )
  }

  const base = String(ctx.baseUrl || '').replace(/\/+$/, '')
  const model = String(args.model || cfg?.model || ctx.model || 'gpt-image-1')
  const started = Date.now()

  const form = new FormData()
  form.append('model', model)
  form.append('prompt', prompt)
  if (args.n) form.append('n', String(Math.min(Math.max(Number(args.n) || 1, 1), 4)))
  if (args.size) form.append('size', String(args.size))

  const parsed = parseDataUrl(source.dataUrl)
  if (!parsed) throw new AppError('源图不是有效的 data URL', 'IMAGE_BAD_SOURCE')
  const blob = new Blob([parsed.bytes], { type: parsed.mime })
  form.append('image', blob, `source.${extOf(parsed.mime)}`)

  // 局部重绘：mask 必须是带透明通道的 PNG，尺寸与源图一致
  if (args.mask) {
    const maskParsed = parseDataUrl(String(args.mask))
    if (maskParsed) {
      form.append('mask', new Blob([maskParsed.bytes], { type: maskParsed.mime }), `mask.${extOf(maskParsed.mime)}`)
    }
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

  const images = []
  for (const d of json.data || []) {
    if (d.b64_json) images.push({ data_url: `data:image/png;base64,${d.b64_json}`, mime: 'image/png' })
    else if (d.url) images.push({ url: d.url, mime: 'image/png' })
  }
  if (!images.length) throw new AppError('上游未返回编辑结果', 'IMAGE_EMPTY_RESULT')

  /* 与 generate_image 一致：写缓存并只返回短 ID。
   * 编辑链路要能继续迭代（改 → 再改），所以 parent_id 记录源图，便于追溯。 */
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
        parent_id: source.record?.id || null,
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
    source_id: source.record?.id || null,
    images: cached.length ? cached : images,
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
    '在已有图片基础上做修改（图生图）。用 image 参数指定源图：可传之前 generate_image / edit_image ' +
    '返回的图片 ID（形如 img_xxx），也可传 data URL。prompt 描述要改成什么样——' +
    '建议明确指出不满意的部分与期望效果，例如「把背景换成海边，人物保持不变」。' +
    '支持 mask 做局部重绘（PNG，透明区域为要重绘的部位）。注意：会产生费用。',
  parameters: jsonSchema(
    {
      image: t.string('源图：图片 ID（img_xxx）或 data URL'),
      prompt: t.string('编辑指令：说明要改什么、改成什么样'),
      mask: t.string('可选。局部重绘遮罩，PNG data URL，透明区域会被重绘'),
      model: t.string('编辑模型名；留空用当前生图模型'),
      n: t.number('生成数量，1-4'),
      size: t.string('输出尺寸，如 1024x1024')
    },
    ['image', 'prompt']
  ),
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

export function registerImageEditTool() {
  if (!toolRegistry.has('edit_image')) toolRegistry.register(editImageTool)
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
