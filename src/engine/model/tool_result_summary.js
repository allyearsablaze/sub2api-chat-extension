/**
 * 工具结果的上下文摘要。
 *
 * 背景：generate_image 返回的是完整 base64（一张 1024² PNG 约 1.5MB，
 * base64 后约 2MB，折算 token 可达百万级）。历史组装若原样下发，
 * 一两轮就会把上下文撑爆，上游直接 400「prompt is too long」。
 *
 * 策略：
 *   - 图片产物替换为占位描述（保留数量、模型、尺寸等元信息）
 *   - 超长字符串字段整体截断
 *   - 其它字段做深度裁剪，保证单个工具结果不超过预算
 *
 * 注意：只影响「发给模型的历史」，不影响界面渲染——
 * 界面仍然从 message_events 读完整 data_url 来显示图片。
 */

/** 单条工具结果进入上下文的字符预算（经验值：约 5k token） */
export const TOOL_RESULT_CONTEXT_BUDGET = 20000

/** 图片在上下文里的占位前缀：一眼看出这是被省略的图片，不是真的没有 */
const IMAGE_PLACEHOLDER = '[图片已省略]'

/**
 * 判断一个值是不是 data URL 形式的图片/base64。
 *
 * 只认明确标记：
 *   1. data:image/...;base64, 开头
 *   2. 纯 base64 字符集且长度很大（无空格换行的连续串）
 *
 * 早期版本把「长字符串」也算作二进制，导致 web_fetch 抓回来的正文、
 * 代码片段等被误判成图片压缩掉，模型完全读不到内容。
 * 这里必须严格：只有真正的 data URL 或纯 base64 才算。
 */
function isInlineBinary(value, minLength = 8192) {
  if (typeof value !== 'string') return false
  if (value.length < minLength) return false

  // 明确的数据 URL（图片/音频/PDF 等）
  if (/^data:[\w.+-]+\/[\w.+-]+;base64,/i.test(value)) return true

  /* 纯 base64 串：只允许 base64 字符与换行，且不含空格。
   * 额外要求「字符多样性」——真实 base64 的 4 种字符分布随机，
   * 而 'DDDDDD...' 这种单字符重复串虽然符合字符集，但显然不是二进制，
   * 不加这条会把占位符、分隔线之类的内容误判成图片。 */
  const sample = value.slice(0, 4096) + value.slice(-4096)
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(sample)) return false
  if (/\s{2,}/.test(sample)) return false
  const distinct = new Set(sample).size
  return distinct >= 8
}

/** 把一张图片对象压成占位描述 */
function summarizeImage(img, index) {
  if (!img || typeof img !== 'object') return `${IMAGE_PLACEHOLDER} #${index + 1}`
  const mime = img.mime || ''
  const bytes = estimateBytes(img)
  const bits = [`${IMAGE_PLACEHOLDER} #${index + 1}`]
  if (mime) bits.push(mime)
  if (bytes) bits.push(`约 ${formatSize(bytes)}`)
  if (img.width && img.height) bits.push(`${img.width}×${img.height}`)
  return bits.join(' ')
}

function estimateBytes(img) {
  const src = img.data_url || img.url || ''
  if (typeof src !== 'string') return 0
  const m = /^data:[^;]+;base64,/.exec(src)
  if (!m) return 0
  // base64 每 4 字符 3 字节
  return Math.round(((src.length - m[0].length) * 3) / 4)
}

function formatSize(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n <= 0) return ''
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`
  return `${(n / 1024 / 1024).toFixed(1)}MB`
}

/**
 * 深度裁剪：把任意工具结果转成「适合进上下文」的纯数据。
 * 返回新对象，不修改原数据（原数据要继续供界面渲染）。
 */
export function summarizeToolResult(payload, {
  budget = TOOL_RESULT_CONTEXT_BUDGET,
  keepInlineImages = false,
} = {}) {
  if (payload === null || payload === undefined) return payload
  if (typeof payload === 'string') {
    if (keepInlineImages) return payload
    if (isInlineBinary(payload)) {
      const bytes = Math.round((payload.length * 3) / 4)
      return `${IMAGE_PLACEHOLDER}（${formatSize(bytes)}）`
    }
    return payload.length > budget ? payload.slice(0, budget) + '…（已截断）' : payload
  }
  if (typeof payload !== 'object') return payload

  const out = Array.isArray(payload) ? [] : {}

  for (const [key, value] of Object.entries(payload)) {
    /* images 数组：如果元素已经是「短 ID 摘要」（含 id 且没有 base64），
     * 必须原样保留——模型要靠这个 ID 后续调用 edit_image / read_image。
     * 只有真的带 base64/data_url 的才降级成占位描述。 */
    if (key === 'images' && Array.isArray(value)) {
      if (keepInlineImages) {
        out.images = value
        continue
      }
      out.images = value.map((img, i) => {
        if (img && typeof img === 'object' && img.id && !img.data_url && !img.url) {
          return img
        }
        return summarizeImage(img, i)
      })
      continue
    }
    // 单图字段
    if (keepInlineImages && (key === 'data_url' || key === 'b64_json' || key === 'base64')) {
      out[key] = value
      continue
    }
    if ((key === 'data_url' || key === 'b64_json' || key === 'base64') && isInlineBinary(value)) {
      out[key] = `${IMAGE_PLACEHOLDER}（${formatSize(Math.round((value.length * 3) / 4))}）`
      continue
    }
    if (isInlineBinary(value)) {
      out[key] = `${IMAGE_PLACEHOLDER}（${formatSize(Math.round((value.length * 3) / 4))}）`
      continue
    }
    if (value && typeof value === 'object') {
      // 嵌套对象递归，但限制深度（防止异常结构导致的深拷贝开销）
      out[key] = summarizeToolResult(value, {
        budget: Math.max(2000, Math.floor(budget / 4)),
        keepInlineImages,
      })
      continue
    }
    if (typeof value === 'string' && value.length > budget) {
      out[key] = value.slice(0, budget) + '…（已截断）'
      continue
    }
    out[key] = value
  }

  // 整体仍超预算时做兜底截断
  let text
  try {
    text = JSON.stringify(out)
  } catch (_) {
    return { ok: payload.ok !== false, note: '工具结果无法序列化，已省略' }
  }
  if (text.length <= budget) return out
  if (keepInlineImages) return out   // 本轮完整下发，不做整体截断

  return {
    ok: payload.ok !== false,
    truncated: true,
    note: `工具结果超过 ${budget} 字符，已压缩。图片内容不会重复发送给模型。`,
    preview: text.slice(0, budget),
  }
}

/** 生成给模型看的工具结果文本（JSON 字符串） */
export function serializeToolResultForContext(payload, options = {}) {
  const summarized = summarizeToolResult(payload, options)
  if (typeof summarized === 'string') return summarized
  try {
    return JSON.stringify(summarized ?? { ok: true })
  } catch (_) {
    return JSON.stringify({ ok: true, note: '工具结果无法序列化' })
  }
}
