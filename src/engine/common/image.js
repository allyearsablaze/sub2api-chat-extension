/** Images API 的输出格式、MIME 与下载扩展名。 */
const IMAGE_MIMES = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
}

export function imageExtension(mime) {
  const type = String(mime || '').split(';')[0].trim().toLowerCase()
  const format = Object.keys(IMAGE_MIMES).find((key) => IMAGE_MIMES[key] === type)
  if (!format) throw new Error(`无法识别图片 MIME：${mime}`)
  return format
}

/** 上游的单张格式优先于响应格式；未声明时沿用请求格式和 Images 默认 PNG。 */
export function parseImageResults(json, requestedFormat) {
  const images = []
  for (const item of json.data || []) {
    if (!item.b64_json && !item.url) continue
    const format = item.output_format || json.output_format || requestedFormat || 'png'
    const dataMime = /^data:(image\/[^;,]+)/i.exec(item.url || '')?.[1]
    const mime = dataMime || IMAGE_MIMES[format]
    if (!mime) throw new Error(`无法识别上游图片格式：${format}`)
    if (item.b64_json) images.push({ data_url: `data:${mime};base64,${item.b64_json}`, mime })
    else images.push({ url: item.url, mime })
  }
  return images
}
