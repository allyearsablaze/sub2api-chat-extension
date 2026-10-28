/**
 * 通用 HTTP 与 SSE 读取工具。浏览器扩展的 service worker 拥有 host_permissions
 * 授权，可直接跨域请求模型服务。
 */

export function joinUrl(base, path) {
  const left = String(base || '').replace(/\/+$/, '')
  const right = String(path || '')
  if (!right) return left
  if (/^https?:\/\//i.test(right)) return right
  return `${left}/${right.replace(/^\/+/, '')}`
}

export async function readSSE(response, onMessage) {
  if (!response.body) return
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let index = buffer.indexOf('\n\n')
    while (index >= 0) {
      const chunk = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      const payloads = []
      for (const line of chunk.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith(':')) continue
        if (trimmed.startsWith('data:')) payloads.push(trimmed.slice(5).trim())
      }
      for (const payload of payloads) {
        if (payload === '[DONE]') {
          onMessage({ done: true })
          continue
        }
        try {
          onMessage({ data: JSON.parse(payload) })
        } catch (_error) {
          onMessage({ text: payload })
        }
      }
      index = buffer.indexOf('\n\n')
    }
  }
  const rest = buffer.trim()
  if (rest.startsWith('data:')) {
    const payload = rest.slice(5).trim()
    if (payload && payload !== '[DONE]') {
      try {
        onMessage({ data: JSON.parse(payload) })
      } catch (_error) {
        /* 忽略不完整尾包 */
      }
    }
  }
}

export async function readJsonOrSSE(response, onMessage) {
  const contentType = response.headers.get('content-type') || ''
  if (contentType.includes('text/event-stream')) {
    await readSSE(response, onMessage)
    return 'sse'
  }
  const payload = await response.json()
  onMessage({ data: payload, whole: true })
  return 'json'
}
