/** 图片格式以文件内容为准，不把请求格式当作生成结果。 */
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

export function detectImageMime(bytes) {
  const starts = (signature) => signature.every((value, index) => bytes[index] === value)
  if (starts([137, 80, 78, 71, 13, 10, 26, 10])) return IMAGE_MIMES.png
  if (starts([255, 216, 255])) return IMAGE_MIMES.jpeg
  const text = new TextDecoder().decode(bytes.subarray(0, 4096))
  if (/^GIF8[79]a/.test(text)) return IMAGE_MIMES.gif
  if (text.startsWith('RIFF') && text.slice(8, 12) === 'WEBP') return IMAGE_MIMES.webp
  const xml = text.replace(/^\uFEFF/, '').replace(/^\s*(?:<\?xml[\s\S]*?\?>\s*)?/, '')
    .replace(/^(?:\s*<!--[\s\S]*?-->\s*)+/, '').replace(/^\s*<!DOCTYPE[^>]*>\s*/i, '')
  if (/^\s*<svg(?:\s|\/?>)/.test(xml)) return IMAGE_MIMES.svg
  throw new Error('图片内容不是可识别的 PNG / JPEG / WebP / GIF / SVG 文件')
}

/** 只解码文件头用于格式检查，保留原始 base64 字节。 */
function mimeFromBase64(base64) {
  const binary = atob(base64.replace(/\s/g, '').slice(0, 8192))
  return detectImageMime(Uint8Array.from(binary, (char) => char.charCodeAt(0)))
}

export function normalizeImageDataUrl(dataUrl) {
  const match = /^data:([^,]*),([\s\S]*)$/.exec(dataUrl)
  if (!match) throw new Error('图片不是有效的 data URL')
  if (/;base64(?:;|$)/i.test(match[1])) {
    const mime = mimeFromBase64(match[2])
    return { data_url: `data:${mime};base64,${match[2]}`, mime }
  }
  const mime = detectImageMime(new TextEncoder().encode(decodeURIComponent(match[2])))
  return { data_url: `data:${mime},${match[2]}`, mime }
}

export function parseImageResults(json, requestedFormat) {
  const images = []
  for (const item of json.data || []) {
    if (!item.b64_json && !item.url) continue
    const declaredFormat = item.output_format || json.output_format
    let image
    if (item.b64_json) {
      image = normalizeImageDataUrl(`data:application/octet-stream;base64,${item.b64_json}`)
    } else if (item.url.startsWith('data:')) {
      image = normalizeImageDataUrl(item.url)
    } else {
      // 远程地址的字节尚未读取；不使用请求格式推断 MIME。
      const mime = IMAGE_MIMES[declaredFormat]
      image = { url: item.url, mime: mime || '' }
    }
    const actualFormat = image.mime ? imageExtension(image.mime) : ''
    const expectedFormat = requestedFormat || declaredFormat
    if (actualFormat && expectedFormat && expectedFormat !== actualFormat) {
      image.format_warning = `请求/声明格式为 ${expectedFormat.toUpperCase()}，上游实际返回 ${actualFormat.toUpperCase()}，已按实际格式显示和保存`
    }
    images.push(image)
  }
  return images
}

/** 远程结果先读取文件内容再缓存，避免 URL 和 Content-Type 再次误标。 */
export async function resolveImageResults(json, requestedFormat, signal) {
  const images = parseImageResults(json, requestedFormat)
  for (const image of images) {
    if (!image.url) continue
    const response = await fetch(image.url, { signal })
    if (!response.ok) throw new Error(`下载上游图片失败：HTTP ${response.status}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    const mime = detectImageMime(bytes)
    const chunks = []
    for (let offset = 0; offset < bytes.length; offset += 8192) {
      chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)))
    }
    const actual = parseImageResults({ data: [{ b64_json: btoa(chunks.join('')), output_format: image.mime ? imageExtension(image.mime) : undefined }] }, requestedFormat)[0]
    Object.assign(image, actual, { mime })
    delete image.url
  }
  return images
}
