/**
 * generate_image：由宿主按当前密钥所属分组的平台能力动态注册。
 *
 * 平台分流严格对齐 sub2api 后端 internal/server/routes/gateway.go 的 imagesHandler：
 *   openai → POST /v1/images/generations
 *   grok   → POST /v1/images/generations
 *   gemini / antigravity → POST /v1beta/models/{model}:generateContent
 *   composite 与其他平台：不支持生图，不注册本工具。
 */
import { toolRegistry, jsonSchema, schemaTypes as t } from './registry.js'
import { AppError } from '../../common/errors.js'
import { cacheImage } from '../../repository/image_cache.js'

export const IMAGE_PLATFORMS = new Set(['openai', 'grok'])
export const GEMINI_IMAGE_PLATFORMS = new Set(['gemini', 'antigravity'])

/** 某平台是否支持生图（与后端 imagesHandler 的 switch 一致） */
export function platformSupportsImage(platform) {
  return IMAGE_PLATFORMS.has(platform) || GEMINI_IMAGE_PLATFORMS.has(platform)
}

/**
 * 该分组是否真的能生图。
 *
 * 后端有两道独立校验，缺一不可：
 *   1. 平台：routes/gateway.go 的 imagesHandler 只对 openai / grok 派发；
 *      gemini 走 /v1beta 独立通道。
 *   2. 分组开关：service/image_generation_intent.go 的
 *      GroupAllowsImageGeneration(group) = group == nil || group.AllowImageGeneration
 *      不满足时返回 403 permission_error。
 *
 * 所以只看平台是不够的——分组关掉开关后平台再支持也会被拒。
 */
export function channelSupportsImage(channel) {
  if (!channel) return false
  if (!platformSupportsImage(channel.platform)) return false
  // channel.allowImageGeneration 来自 /groups/available 的 allow_image_generation
  return channel.allowImageGeneration === true
}

/** 从模型列表里挑出生图模型（用于独立选择生图模型） */
export function pickImageModels(models, platform) {
  const list = Array.isArray(models) ? models : []
  return list.filter((m) => isImageModel(m, platform))
}

/** 模型名是否属于生图模型 */
export function isImageModel(model, platform) {
  const m = String(model || '').toLowerCase().trim()
  if (m.startsWith('gpt-image-') || m.startsWith('grok-imagine') || m.startsWith('dall-e')) return true
  if (GEMINI_IMAGE_PLATFORMS.has(platform)) {
    return /^gemini-.*(-image|image-)/.test(m)
  }
  return /^gemini-.*(-image|image-)/.test(m)
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

/**
 * 真正执行生图。ctx 由宿主注入：
 *   { apiKey, platform, baseUrl, model }
 * baseUrl 为空时使用同源绝对路径（部署在同域名下时最短路径）。
 */
export async function runImageGeneration(args, ctx = {}) {
  /* 优先使用设置页配置的生图分组与模型（imageConfig），
   * 这样生图与当前对话所用的密钥/模型解耦 */
  const cfg = ctx.imageConfig && ctx.imageConfig.apiKey ? ctx.imageConfig : null
  const apiKey = cfg ? cfg.apiKey : ctx.apiKey
  const platform = cfg ? cfg.platform : (ctx.platform || '')

  if (!apiKey) throw new AppError('生图密钥不可用，请在设置中配置生图分组', 'IMAGE_NO_KEY')
  if (!platformSupportsImage(platform)) {
    throw new AppError(`平台「${platform}」不支持生图`, 'IMAGE_PLATFORM_UNSUPPORTED')
  }

  const prompt = String(args.prompt || '').trim()
  if (!prompt) throw new AppError('prompt 不能为空', 'IMAGE_EMPTY_PROMPT')

  const base = String(ctx.baseUrl || '').replace(/\/+$/, '')
  const signal = ctx.signal
  const started = Date.now()

  if (GEMINI_IMAGE_PLATFORMS.has(platform)) {
    const model = String(args.model || cfg?.model || ctx.model || 'gemini-2.5-flash-image').replace(/^models\//, '')
    const url = `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`
    const resp = await fetch(url, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
      })
    })
    if (!resp.ok) throw new AppError(await readError(resp), 'IMAGE_REQUEST_FAILED')
    const json = await resp.json()
    if (json.error) throw new AppError(json.error.message || 'Gemini 返回错误', 'IMAGE_UPSTREAM_ERROR')

    const images = []
    for (const cand of json.candidates || []) {
      for (const part of (cand.content && cand.content.parts) || []) {
        const inline = part.inlineData || part.inline_data
        if (inline && inline.data) {
          const mime = inline.mimeType || inline.mime_type || 'image/png'
          images.push({ data_url: `data:${mime};base64,${inline.data}`, mime })
        }
      }
    }
    if (!images.length) throw new AppError('上游未返回图片数据', 'IMAGE_EMPTY_RESULT')
    const cached1 = await persistImages(images, { prompt, model, platform, sessionId: ctx.sessionId, turnId: ctx.turnId })
    return { ok: true, model, platform, images: cached1, elapsed_ms: Date.now() - started }
  }

  // OpenAI / Grok
  const model = String(args.model || cfg?.model || ctx.model || 'gpt-image-1')
  const body = { model, prompt, n: Math.min(Math.max(Number(args.n) || 1, 1), 4) }
  if (args.size) body.size = String(args.size)
  if (args.quality) body.quality = String(args.quality)

  const resp = await fetch(`${base}/v1/images/generations`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body)
  })
  if (!resp.ok) throw new AppError(await readError(resp), 'IMAGE_REQUEST_FAILED')
  const json = await resp.json()
  if (json.error) throw new AppError(json.error.message || '生图失败', 'IMAGE_UPSTREAM_ERROR')

  const images = []
  for (const d of json.data || []) {
    if (d.b64_json) images.push({ data_url: `data:image/png;base64,${d.b64_json}`, mime: 'image/png' })
    else if (d.url) images.push({ url: d.url, mime: 'image/png' })
  }
  if (!images.length) throw new AppError('上游未返回图片数据', 'IMAGE_EMPTY_RESULT')
  const cached2 = await persistImages(images, { prompt, model, platform, sessionId: ctx.sessionId, turnId: ctx.turnId })
  return { ok: true, model, platform, images: cached2, elapsed_ms: Date.now() - started }
}

/**
 * 把生成的图片写入缓存，并附上短 ID。
 *
 * 返回给模型的 images 只保留 { id, mime, bytes } —— 不带 base64。
 * 界面渲染需要完整图，另行从缓存按 ID 取（见 EventTimeline）。
 */
async function persistImages(images, meta = {}) {
  const out = []
  for (const img of images) {
    const dataUrl = img.data_url || img.url || ''
    if (!dataUrl) continue
    const bytes = Math.round((String(dataUrl).length * 3) / 4)
    try {
      const row = await cacheImage({
        data_url: dataUrl,
        mime: img.mime || 'image/png',
        prompt: meta.prompt || '',
        action: 'generate',
        session_id: meta.sessionId ?? null,
        turn_id: meta.turnId ?? null,
        model: meta.model || '',
      })
      out.push({ id: row.id, mime: row.mime, bytes })
    } catch (_) {
      // 缓存失败不能让生图整体失败：至少把结果给出去
      out.push({ mime: img.mime || 'image/png', bytes, data_url: dataUrl })
    }
  }
  return out.length ? out : images
}

const generateImageTool = {
  name: 'generate_image',
  category: 'image',
  risk: 'medium',
  readOnly: false,
  /* 生图普遍 40–150 秒，默认 60 秒经常不够。
   * 声明 180 秒上限，实际取「设置里的全局超时」与它的较大值。 */
  timeoutMs: 180000,
  description:
    '生成图片。根据文字描述（prompt）调用当前密钥所属平台的生图接口，返回图片（base64 data URL 或直链）。' +
    '适合绘制插画、生成示意图、根据描述创作视觉内容。注意：生成图片会产生费用。',
  parameters: jsonSchema(
    {
      prompt: t.string('图片描述，越具体越好（主体、风格、构图、光线等）'),
      model: t.string('生图模型名；留空则使用当前选中的生图模型'),
      n: t.number('生成数量，1-4，默认 1'),
      size: t.string('尺寸，如 1024x1024（仅部分模型支持）'),
      quality: t.string('质量，如 standard / high（仅部分模型支持）'),
      timeout_secs: t.number(
        '本次调用允许的最长等待秒数，默认 180。'
        + '大尺寸、n>1 或高画质会更慢，可调大到 300。上限 600。'
      )
    },
    ['prompt']
  ),
  handler: async (args, ctx = {}) => runImageGeneration(args, ctx)
}

export function registerImageTool() {
  if (!toolRegistry.has('generate_image')) {
    toolRegistry.register(generateImageTool)
  }
  return toolRegistry
}

export function unregisterImageTool() {
  toolRegistry.tools.delete('generate_image')
}
