/**
 * 附件处理：粘贴取文件、图片压缩、IndexedDB 存储。
 *
 * 复用 SmartPageAgent 的 clipboardFiles 语义：
 *   优先 clipboardData.files，回退 items → getAsFile；
 *   只有确实取到文件时才 preventDefault，避免吞掉普通文本粘贴。
 */

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024   // 单文件 10MB
export const MAX_IMAGE_EDGE = 1568                    // 长边压缩到 1568px（视觉模型惯例）

export function clipboardFiles(clipboardData) {
  const files = [...(clipboardData?.files || [])].filter(Boolean)
  if (files.length) return files
  return [...(clipboardData?.items || [])]
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter(Boolean)
}

/** 取到文件才拦截默认行为；纯文本粘贴照常进行 */
export function consumeClipboardAttachments(event) {
  const files = clipboardFiles(event.clipboardData)
  if (!files.length) return []
  event.preventDefault()
  return files
}

export function isImageFile(file) {
  return String(file?.type || '').toLowerCase().startsWith('image/')
}

export function formatSize(size) {
  const n = Number(size)
  if (!Number.isFinite(n) || n <= 0) return '-'
  const units = ['B', 'KB', 'MB', 'GB']
  let v = n, i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

/** 读为 data URL */
function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })
}

/**
 * 图片压缩：长边超过 MAX_IMAGE_EDGE 时等比缩放，输出 JPEG。
 * 非图片或本来就是小图则原样返回 data URL。
 */
export async function toDataURL(file) {
  const raw = await readAsDataURL(file)
  if (!isImageFile(file)) return raw

  try {
    const img = await new Promise((resolve, reject) => {
      const image = new Image()
      image.onload = () => resolve(image)
      image.onerror = () => reject(new Error('图片解码失败'))
      image.src = raw
    })
    const { width, height } = img
    const longest = Math.max(width, height)
    if (longest <= MAX_IMAGE_EDGE) return raw

    const scale = MAX_IMAGE_EDGE / longest
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(width * scale)
    canvas.height = Math.round(height * scale)
    const ctx = canvas.getContext('2d')
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.9)
  } catch (_) {
    return raw   // 压缩失败就用原图，不影响主流程
  }
}

/** 把用户选的/粘贴的文件转成可发送的附件对象 */
export async function prepareAttachment(file) {
  if (!file) return null
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`「${file.name || '文件'}」超过 ${formatSize(MAX_ATTACHMENT_BYTES)} 上限`)
  }
  const dataUrl = await toDataURL(file)
  return {
    id: `a-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    file_name: file.name || '粘贴的图片',
    content_type: file.type || 'application/octet-stream',
    size: file.size || 0,
    data_url: dataUrl,
  }
}
