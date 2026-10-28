import { toolRegistry, jsonSchema, schemaTypes as t } from './registry.js'
import { AppError } from '../../common/errors.js'

/**
 * web_fetch：抓取远程网页并抽取正文。
 *
 * 扩展的 service worker 没有 DOM（DOMParser 不可用），因此这里用
 * 「去噪 → 结构替换 → 去标签 → 实体解码」的轻量管线把 HTML 转成 Markdown/纯文本。
 * 目标不是完美还原，而是给模型一份可读、可引用、长度可控的正文。
 */

const MAX_RAW_CHARS = 2000000

const ENTITY_MAP = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
  hellip: '…',
  mdash: '—',
  ndash: '–',
  copy: '©',
  reg: '®',
  trade: '™',
  laquo: '«',
  raquo: '»',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  middot: '·',
  times: '×',
  divide: '÷'
}

function fromCodePoint(code) {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return ''
  try {
    return String.fromCodePoint(code)
  } catch (_error) {
    return ''
  }
}

export function decodeEntities(text) {
  return String(text || '')
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec) => fromCodePoint(Number(dec)))
    .replace(/&([a-z#0-9]+);/gi, (match, name) => ENTITY_MAP[String(name).toLowerCase()] ?? match)
}

/** 删除不参与正文的节点（脚本、样式、模板、内嵌框架等） */
function stripNoise(html) {
  return String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|canvas|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(script|style|link|meta)\b[^>]*\/?>/gi, ' ')
}

function attr(tag, name) {
  const match = String(tag).match(new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))
  if (!match) return ''
  return decodeEntities(match[2] ?? match[3] ?? match[4] ?? '')
}

function absoluteUrl(value, base) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (/^(data:|mailto:|tel:|javascript:)/i.test(raw)) return raw
  try {
    return new URL(raw, base).toString()
  } catch (_error) {
    return raw
  }
}

function inlineText(html) {
  return decodeEntities(String(html || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

function tidy(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** HTML → Markdown（保留标题、列表、链接、图片、代码块与表格的基本结构） */
export function htmlToMarkdown(html, { baseUrl = '', keepLinks = true } = {}) {
  let text = stripNoise(html)
  text = text.replace(
    /<pre\b[^>]*>[\s\S]*?<code\b[^>]*>([\s\S]*?)<\/code>[\s\S]*?<\/pre>/gi,
    (_match, code) => `\n\n\`\`\`\n${decodeEntities(code).replace(/\n{3,}/g, '\n\n').trim()}\n\`\`\`\n\n`
  )
  text = text.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_match, code) => {
    const value = inlineText(code)
    return value ? `\`${value}\`` : ''
  })
  text = text.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_match, level, inner) => {
    const title = inlineText(inner)
    return title ? `\n\n${'#'.repeat(Number(level))} ${title}\n\n` : '\n\n'
  })
  text = text.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = attr(tag, 'src')
    if (!src) return ''
    return `![${attr(tag, 'alt')}](${absoluteUrl(src, baseUrl)})`
  })
  text = text.replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, (tag, inner) => {
    const label = inlineText(inner)
    const href = attr(tag, 'href')
    if (!label) return ''
    if (!keepLinks || !href) return label
    return `[${label}](${absoluteUrl(href, baseUrl)})`
  })
  text = text.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_match, _tag, inner) => {
    const value = inlineText(inner)
    return value ? `**${value}**` : ''
  })
  text = text.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_match, _tag, inner) => {
    const value = inlineText(inner)
    return value ? `*${value}*` : ''
  })
  text = text.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_match, inner) => {
    const body = tidy(decodeEntities(String(inner).replace(/<[^>]+>/g, '\n')))
    if (!body) return ''
    return `\n\n${body
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n')}\n\n`
  })
  text = text.replace(/<li\b[^>]*>/gi, '\n- ')
  text = text.replace(/<br\s*\/?>/gi, '\n')
  text = text.replace(/<(td|th)\b[^>]*>/gi, ' | ')
  text = text.replace(/<(hr)\b[^>]*>/gi, '\n\n---\n\n')
  text = text.replace(
    /<\/(p|div|section|article|header|footer|aside|main|nav|tr|table|ul|ol|h[1-6]|blockquote|figure)>/gi,
    '\n\n'
  )
  text = text.replace(/<[^>]+>/g, '')
  return tidy(decodeEntities(text))
}

/** HTML → 纯文本（保留段落与列表换行） */
export function htmlToText(html) {
  let text = stripNoise(html)
  text = text.replace(/<li\b[^>]*>/gi, '\n- ')
  text = text.replace(/<br\s*\/?>/gi, '\n')
  text = text.replace(/<(td|th)\b[^>]*>/gi, '\t')
  text = text.replace(
    /<\/(p|div|section|article|header|footer|aside|main|nav|tr|table|ul|ol|h[1-6]|blockquote|li|pre)>/gi,
    '\n'
  )
  text = text.replace(/<[^>]+>/g, '')
  return tidy(decodeEntities(text))
}

export function extractTitle(html) {
  const match = String(html || '').match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)
  return match ? inlineText(match[1]) : ''
}

export function extractMetaDescription(html) {
  const source = String(html || '')
  const patterns = [
    /<meta[^>]+name\s*=\s*["']description["'][^>]*content\s*=\s*["']([^"']*)["']/i,
    /<meta[^>]+content\s*=\s*["']([^"']*)["'][^>]*name\s*=\s*["']description["']/i,
    /<meta[^>]+property\s*=\s*["']og:description["'][^>]*content\s*=\s*["']([^"']*)["']/i
  ]
  for (const pattern of patterns) {
    const match = source.match(pattern)
    if (match) return decodeEntities(match[1]).trim()
  }
  return ''
}

function allowedDomains(settings = {}) {
  return String(settings.web_fetch_allowed_domains || '')
    .split(/[\n,]/)
    .map((item) => item.trim().toLowerCase().replace(/^\*?\./, ''))
    .filter(Boolean)
}

function domainAllowed(hostname, settings) {
  const rules = allowedDomains(settings)
  if (!rules.length) return true
  const host = String(hostname || '').toLowerCase()
  return rules.some((rule) => host === rule || host.endsWith(`.${rule}`))
}

function clampNumber(value, min, max, fallback) {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, num))
}

function parseTargetUrl(raw) {
  const value = String(raw || '').trim()
  if (!value) throw new AppError('缺少 url 参数', 'WEB_FETCH_URL_REQUIRED')
  let parsed
  try {
    parsed = new URL(value)
  } catch (_error) {
    throw new AppError(`URL 格式不正确：${value}`, 'WEB_FETCH_INVALID_URL')
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new AppError('只支持 http/https 地址；浏览器内部页面与本地文件无法抓取', 'WEB_FETCH_UNSUPPORTED_PROTOCOL')
  }
  return parsed
}

function truncateContent(content, limit) {
  const text = String(content || '')
  if (text.length <= limit) return { content: text, truncated: false }
  return {
    content: `${text.slice(0, limit)}\n\n…（正文超过 ${limit} 字符，已截断；可用 max_chars 调整或抓取更具体的页面）`,
    truncated: true
  }
}

export const webFetchTool = {
  name: 'web_fetch',
  category: 'web',
  risk: 'medium',
  readOnly: true,
  description:
    '抓取一个 http/https 网页并抽取正文，支持返回 Markdown（默认，保留标题/列表/链接）、纯文本或原始 HTML。适合读取文档、文章、公开接口的文本响应；无法访问浏览器内部页面（chrome://）、本地文件或需要登录的页面。',
  parameters: jsonSchema(
    {
      url: t.string('要抓取的完整地址，必须以 http:// 或 https:// 开头'),
      format: t.enum('返回格式：markdown 保留结构，text 纯文本，html 原始 HTML', ['markdown', 'text', 'html']),
      max_chars: t.number('正文最大字符数，默认取设置里的「返回字符上限」'),
      timeout_secs: t.number('请求超时秒数，默认取设置里的「抓取超时」'),
      keep_links: t.boolean('Markdown 格式下是否保留链接，默认 true')
    },
    ['url']
  ),
  handler: async (args = {}, ctx = {}) => {
    const settings = ctx.settings || {}
    if (settings.web_fetch_enabled === false) {
      throw new AppError('web_fetch 已在设置中关闭', 'WEB_FETCH_DISABLED')
    }
    const target = parseTargetUrl(args.url)
    if (!domainAllowed(target.hostname, settings)) {
      throw new AppError(
        `域名 ${target.hostname} 不在 web_fetch 白名单内，可在「设置 → 网络抓取」中调整`,
        'WEB_FETCH_DOMAIN_BLOCKED'
      )
    }

    const timeoutSecs = clampNumber(args.timeout_secs ?? settings.web_fetch_timeout_secs, 3, 120, 20)
    const maxChars = clampNumber(args.max_chars ?? settings.web_fetch_max_chars, 50, 500000, 20000)
    const format = ['markdown', 'text', 'html'].includes(args.format) ? args.format : 'markdown'
    const keepLinks = args.keep_links !== false

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutSecs * 1000)
    const startedAt = Date.now()
    let response
    try {
      response = await fetch(target.toString(), {
        method: 'GET',
        redirect: 'follow',
        credentials: 'omit',
        signal: controller.signal,
        headers: {
          accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8'
        }
      })
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new AppError(`抓取超时（${timeoutSecs}s）：${target.toString()}`, 'WEB_FETCH_TIMEOUT')
      }
      throw new AppError(`抓取失败：${error?.message || error}`, 'WEB_FETCH_FAILED')
    } finally {
      clearTimeout(timer)
    }

    const contentType = response.headers.get('content-type') || ''
    const raw = (await response.text()).slice(0, MAX_RAW_CHARS)
    if (!response.ok) {
      throw new AppError(
        `目标站点返回 HTTP ${response.status}：${raw.slice(0, 200).replace(/\s+/g, ' ')}`,
        'WEB_FETCH_HTTP_ERROR'
      )
    }

    const isHtml = /html|xml/i.test(contentType) || /^\s*<(!doctype|html|head|body)/i.test(raw)
    const isJson = /json/i.test(contentType)
    let content = raw
    if (isJson) {
      try {
        content = JSON.stringify(JSON.parse(raw), null, 2)
      } catch (_error) {
        content = raw
      }
      if (format === 'html') content = raw
    } else if (isHtml) {
      if (format === 'html') content = raw
      else if (format === 'text') content = htmlToText(raw)
      else content = htmlToMarkdown(raw, { baseUrl: response.url || target.toString(), keepLinks })
    }

    const limited = truncateContent(content, maxChars)
    return {
      ok: true,
      url: response.url || target.toString(),
      status: response.status,
      content_type: contentType.split(';')[0] || '',
      format: isJson ? 'json' : isHtml ? format : 'text',
      title: isHtml ? extractTitle(raw) : '',
      description: isHtml ? extractMetaDescription(raw) : '',
      content: limited.content,
      chars: limited.content.length,
      truncated: limited.truncated,
      elapsed_ms: Date.now() - startedAt
    }
  }
}

const webTools = [webFetchTool]

export function registerWebTools() {
  for (const tool of webTools) toolRegistry.register(tool)
}

export const webToolNames = webTools.map((tool) => tool.name)
