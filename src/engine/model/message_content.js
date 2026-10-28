/**
 * 用户消息内容组装。
 *
 * 无附件或只有非图片附件时仍是纯字符串（保持旧历史与接口兼容）；
 * 有图片时返回协议中立的 parts 数组，由各 provider 转换成自己的图片块格式：
 *   { type: 'text', text }
 *   { type: 'image', media_type, data_url }
 */

/** 非图片附件对模型的文字说明：只透出元信息，不做内容解析 */
export function describeAttachment(meta = {}) {
  const name = meta.file_name || meta.name || '附件'
  const type = meta.content_type || meta.type || '未知类型'
  const size = Number(meta.size)
  const sizeText = Number.isFinite(size) && size > 0 ? `${Math.round(size / 1024)} KB` : '未知大小'
  return `[附件] ${name}（${type}，${sizeText}）`
}

export function buildUserContent(text, attachments = []) {
  const value = String(text || '')
  const items = Array.isArray(attachments) ? attachments : []
  if (!items.length) return value
  const parts = []
  if (value.trim()) parts.push({ type: 'text', text: value })
  let hasImage = false
  for (const item of items) {
    if (item?.image) {
      hasImage = true
      parts.push({
        type: 'image',
        media_type: item.image.content_type || 'image/png',
        data_url: item.image.data_url
      })
    } else {
      parts.push({ type: 'text', text: describeAttachment(item?.meta || item) })
    }
  }
  if (!hasImage) {
    /* 没有图片时不必发 parts，避免部分兼容端点不认数组 */
    return [value, ...parts.filter((part) => part.type === 'text').map((part) => part.text)]
      .filter((segment) => segment && segment.trim())
      .join('\n\n')
  }
  return parts
}

/** 内容里的文本部分，用于摘要、标题、token 估算与纯文本兜底 */
export function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part?.type === 'text')
    .map((part) => part.text)
    .join('\n')
}
