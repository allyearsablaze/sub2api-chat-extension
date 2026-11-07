import { AppError } from '../../common/errors.js'
import { jsonSchema, schemaTypes as t } from './registry.js'

export const imageOptionProperties = {
  quality: t.string('输出质量，如 auto / low / medium / high（仅部分模型支持）'),
  output_format: t.enum('输出格式；SVG 矢量图和 GIF 动图需要 OpenAI gpt-image-2.6-flare / gpt-image-2.6-sunburst', ['png', 'jpeg', 'webp', 'gif', 'svg']),
  complexity: t.string('gpt-image-2.6 的图像复杂度，如 low；与 SVG 作者模型的推理强度独立'),
  frame_count: { type: 'integer', minimum: 1, description: 'GIF 动图帧数，仅 output_format=gif 时使用' },
  frame_duration_ms: { type: 'integer', minimum: 1, description: 'GIF 每帧时长（毫秒），仅 output_format=gif 时使用' },
  svg: t.object('SVG 作者配置，仅 output_format=svg 时使用', jsonSchema({
    model: t.string('可选的 SVG 作者模型名，如 gpt-6-astra；不是生图模型名'),
    reasoning: t.object('SVG 作者模型的推理配置', jsonSchema({
      effort: t.string('推理强度，如 high'),
    })),
  })),
}

function invalid(message) {
  throw new AppError(message, 'IMAGE_INVALID_OPTIONS')
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 生成用 JSON，编辑用 multipart；两者共享同一份参数契约。 */
export function buildImageOptions(args, { model, platform }) {
  const options = {}
  if (args.quality) options.quality = String(args.quality)
  if (args.output_format !== undefined) {
    if (!imageOptionProperties.output_format.enum.includes(args.output_format)) invalid('不支持的 output_format')
    options.output_format = args.output_format
  }
  const hasFrames = args.frame_count !== undefined || args.frame_duration_ms !== undefined
  const hasNativeOptions = ['gif', 'svg'].includes(options.output_format) || hasFrames || args.svg !== undefined || args.complexity !== undefined
  if (hasNativeOptions && (platform !== 'openai' || !/^gpt-image-2\.6(?:-|$)/i.test(model))) {
    invalid('SVG / GIF、帧控制、SVG 作者配置及 complexity 需要 OpenAI gpt-image-2.6 模型')
  }
  if (platform === 'gemini' || platform === 'antigravity') {
    if (Object.keys(options).length) invalid('Gemini 通道不支持这些 Images 输出参数')
  }
  if (args.complexity !== undefined) {
    if (typeof args.complexity !== 'string' || !args.complexity.trim()) invalid('complexity 必须是非空字符串')
    options.complexity = args.complexity
  }
  if (hasFrames && options.output_format !== 'gif') invalid('帧控制参数需要 output_format=gif')
  for (const key of ['frame_count', 'frame_duration_ms']) {
    if (args[key] === undefined) continue
    if (!Number.isSafeInteger(args[key]) || args[key] <= 0) invalid(`${key} 必须是正整数`)
    options[key] = args[key]
  }
  if (args.svg !== undefined) {
    if (options.output_format !== 'svg') invalid('svg 作者配置需要 output_format=svg')
    if (!isObject(args.svg)) invalid('svg 必须是对象')
    const svg = args.svg
    if (Object.keys(svg).some((key) => !['model', 'reasoning'].includes(key))) invalid('svg 只支持 model 和 reasoning')
    if (svg.model !== undefined && (typeof svg.model !== 'string' || !svg.model.trim())) invalid('svg.model 必须是非空字符串')
    if (svg.reasoning !== undefined) {
      if (!isObject(svg.reasoning) || Object.keys(svg.reasoning).some((key) => key !== 'effort')) invalid('svg.reasoning 只支持 effort')
      if (svg.reasoning.effort !== undefined && (typeof svg.reasoning.effort !== 'string' || !svg.reasoning.effort.trim())) invalid('svg.reasoning.effort 必须是非空字符串')
    }
    options.svg = svg
  }
  return options
}
