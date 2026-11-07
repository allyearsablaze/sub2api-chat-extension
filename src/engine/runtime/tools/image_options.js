import { AppError } from '../../common/errors.js'
import { jsonSchema, schemaTypes as t } from './registry.js'

/** 生图模型只由设置提供，不接受工具参数或对话模型作为替代。 */
export function requireImageConfig(ctx) {
  const config = ctx.imageConfig
  if (!config?.apiKey) throw new AppError('生图密钥不可用，请在设置中配置生图分组', 'IMAGE_NO_KEY')
  const model = String(config.model || '').trim()
  if (!model) throw new AppError('未配置生图模型，请在设置中选择', 'IMAGE_NO_MODEL')
  return { ...config, model }
}

/** 同一份能力规则供注册和执行使用；模型名称不做映射或自动替换。 */
export function imageCapabilities({ model, platform }) {
  const gemini = ['gemini', 'antigravity'].includes(platform)
  const gptImage = platform === 'openai' && /^gpt-image-/i.test(model)
  const image26 = platform === 'openai' && /^gpt-image-2\.6(?:-|$)/i.test(model)
  const properties = {}
  if (!gemini) {
    properties.n = t.number('生成数量，1-4，默认 1')
    properties.size = t.string('输出尺寸，如 1024x1024；可用尺寸由当前模型决定')
    if (platform === 'openai') properties.quality = t.string('输出质量；可用取值由当前配置模型决定')
  }
  if (gptImage) {
    properties.output_format = t.enum('输出文件格式', image26 ? ['png', 'jpeg', 'webp', 'gif', 'svg'] : ['png', 'jpeg', 'webp'])
  }
  if (image26) {
    properties.complexity = t.string('图像复杂度，如 low；与 SVG 推理强度独立')
    properties.frame_count = { type: 'integer', minimum: 1, description: 'GIF 动图帧数，仅 output_format=gif 时使用' }
    properties.frame_duration_ms = { type: 'integer', minimum: 1, description: 'GIF 每帧时长（毫秒），仅 output_format=gif 时使用' }
    properties.svg = t.object('SVG 推理配置，仅 output_format=svg 时使用；作者模型由上游决定', jsonSchema({
      reasoning: t.object('SVG 推理配置', jsonSchema({ effort: t.string('推理强度，如 high') })),
    }))
  }
  const formats = properties.output_format?.enum
  return {
    properties,
    supportsEdit: !gemini,
    description: `当前固定使用用户配置的模型「${model}」（平台 ${platform}），不可自行选择或更换模型。`
      + (formats ? `可请求的输出格式：${formats.join(' / ')}。` : '输出格式由当前模型接口决定。')
      + (image26 ? '支持请求 SVG 矢量图、GIF 动图及帧数/帧时长控制；实际能力以上游响应为准。' : ''),
  }
}

function invalid(message) {
  throw new AppError(message, 'IMAGE_INVALID_OPTIONS')
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 生成用 JSON，编辑用 multipart；未暴露的图片参数不允许夹带执行。 */
export function buildImageOptions(args, config) {
  const { properties } = imageCapabilities(config)
  for (const key of ['n', 'size', 'quality', 'output_format', 'complexity', 'frame_count', 'frame_duration_ms', 'svg']) {
    if (args[key] !== undefined && !properties[key]) invalid(`当前配置模型「${config.model}」不支持参数 ${key}`)
  }
  const options = {}
  if (args.quality) options.quality = String(args.quality)
  if (args.output_format !== undefined) {
    if (!properties.output_format.enum.includes(args.output_format)) invalid('当前配置模型不支持该 output_format')
    options.output_format = args.output_format
  }
  if (args.complexity !== undefined) {
    if (typeof args.complexity !== 'string' || !args.complexity.trim()) invalid('complexity 必须是非空字符串')
    options.complexity = args.complexity
  }
  const hasFrames = args.frame_count !== undefined || args.frame_duration_ms !== undefined
  if (hasFrames && options.output_format !== 'gif') invalid('帧控制参数需要 output_format=gif')
  for (const key of ['frame_count', 'frame_duration_ms']) {
    if (args[key] === undefined) continue
    if (!Number.isSafeInteger(args[key]) || args[key] <= 0) invalid(`${key} 必须是正整数`)
    options[key] = args[key]
  }
  if (args.svg !== undefined) {
    if (options.output_format !== 'svg') invalid('svg 配置需要 output_format=svg')
    if (!isObject(args.svg)) invalid('svg 必须是对象')
    const svg = args.svg
    if (Object.keys(svg).some((key) => key !== 'reasoning')) invalid('svg 只支持 reasoning，不允许选择作者模型')
    if (svg.reasoning !== undefined) {
      if (!isObject(svg.reasoning) || Object.keys(svg.reasoning).some((key) => key !== 'effort')) invalid('svg.reasoning 只支持 effort')
      if (svg.reasoning.effort !== undefined && (typeof svg.reasoning.effort !== 'string' || !svg.reasoning.effort.trim())) invalid('svg.reasoning.effort 必须是非空字符串')
    }
    options.svg = svg
  }
  return options
}
