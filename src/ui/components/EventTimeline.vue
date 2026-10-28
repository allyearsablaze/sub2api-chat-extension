<template>
  <div class="timeline">
    <div v-for="(turn, ti) in turns" :key="turn.turnId || ti" class="turn">
      <template v-for="(item, ii) in turn.items" :key="item.event?.id || `${ti}-${ii}`">
        <!-- 用户气泡 -->
        <div v-if="item.kind === 'user'" class="user-row" :class="{ append: item.isAppend }">
          <div class="user-bubble">
            <div v-if="textOf(item.event)" class="bubble-text">{{ textOf(item.event) }}</div>
            <div v-if="eventImages(item.event).length" class="bubble-images">
              <figure v-for="(src, i) in eventImages(item.event)" :key="i">
                <img :src="src" loading="lazy" @click="$emit('preview', src)" />
              </figure>
            </div>
            <div v-if="eventFiles(item.event).length" class="bubble-files">
              <span v-for="(f, i) in eventFiles(item.event)" :key="i" class="file-chip">
                📄 {{ f.file_name }}
              </span>
            </div>
            <div v-if="item.event.created_at" class="bubble-time">
              {{ formatTime(item.event.created_at) }}
            </div>
          </div>
        </div>

        <!-- 助手轨道 -->
        <div v-else-if="item.kind === 'timeline'" class="assistant-track">
          <div class="rail"></div>
          <div class="rows">
            <div v-for="block in item.blocks" :key="blockKey(block)" class="row">
              <!-- 思考 -->
              <template v-if="block.kind === 'reasoning'">
                <button class="row-head" @click="toggle(blockKey(block))">
                  <span class="row-icon">💭</span>
                  <span class="row-title">思考过程</span>
                  <span class="row-sub">{{ block.summary }}</span>
                  <span v-if="block.createdAt" class="row-time">{{ formatClock(block.createdAt) }}</span>
                  <span class="row-chevron">{{ isOpen(blockKey(block)) ? '▾' : '▸' }}</span>
                </button>
                <div v-if="isOpen(blockKey(block))" class="row-body">
                  <div class="reasoning-text">{{ block.text }}</div>
                </div>
              </template>

              <!-- 工具调用 -->
              <template v-else-if="block.kind === 'tool'">
                <button class="row-head" @click="toggle(blockKey(block))">
                  <span class="row-icon">🔧</span>
                  <span class="row-title">调用 {{ block.name }}</span>
                  <span v-if="block.status === 'running'" class="spinner"></span>
                  <span v-else-if="block.status === 'failed'" class="badge-err">失败</span>
                  <span class="row-sub">{{ argSummary(block.arguments) }}</span>
                  <span v-if="block.createdAt" class="row-time">{{ formatClock(block.createdAt) }}</span>
                  <span class="row-chevron">{{ isOpen(blockKey(block)) ? '▾' : '▸' }}</span>
                </button>
                <div v-if="isOpen(blockKey(block))" class="row-body">
                  <div class="tool-grid">
                    <div class="tool-pane">
                      <div class="pane-label">参数</div>
                      <pre class="pane-code">{{ pretty(block.arguments) }}</pre>
                    </div>
                    <div class="tool-pane">
                      <div class="pane-label">返回</div>
                      <pre class="pane-code">{{ prettyResult(block.result) }}</pre>
                    </div>
                  </div>
                </div>
                <!-- 生图产物是核心产出，不折叠、始终可见 -->
                <div v-if="imagesOf(block.result).length" class="tool-images">
                  <figure v-for="(entry, i) in imagesOf(block.result)" :key="i">
                    <SafeImage :entry="entry" @preview="$emit('preview', $event)" />
                  </figure>
                </div>
              </template>

              <!-- 回复正文 -->
              <template v-else-if="block.kind === 'reply'">
                <div class="reply-body">
                  <div v-if="block.closing" class="closing-tag">收尾</div>
                  <div class="markdown" v-html="renderMarkdown(block.text)"></div>
                  <span v-if="block.streaming" class="cursor"></span>
                  <div v-if="block.usage" class="usage">{{ usageText(block.usage) }}</div>
                </div>
              </template>

              <!-- 重试 -->
              <template v-else-if="block.kind === 'retry'">
                <button class="row-head" @click="toggle(blockKey(block))">
                  <span class="row-icon">🔄</span>
                  <span class="row-title">重试 ×{{ block.retryCount }}</span>
                  <span class="row-sub">{{ block.error ? String(block.error).slice(0, 80) : '' }}</span>
                  <span class="row-chevron">{{ isOpen(blockKey(block)) ? '▾' : '▸' }}</span>
                </button>
                <div v-if="isOpen(blockKey(block))" class="row-body">
                  <div class="simple-text">
                    <div v-if="block.error">原因：{{ block.error }}</div>
                    <div v-if="block.delayMs">退避：{{ block.delayMs }}ms{{ block.backoffCapped ? '（已达上限）' : '' }}</div>
                    <div v-if="block.attempts.length">尝试记录：{{ block.attempts.join(' → ') }}</div>
                  </div>
                </div>
              </template>

              <!-- 提示 -->
              <template v-else-if="block.kind === 'note'">
                <div class="note-row">{{ block.text }}</div>
              </template>

              <!-- 错误 -->
              <template v-else-if="block.kind === 'error'">
                <div class="row-head static">
                  <span class="row-icon">⚠️</span>
                  <span class="row-title">{{ block.cancelled ? '已取消' : '执行失败' }}</span>
                </div>
                <div class="row-body">
                  <div class="simple-text err">{{ block.text }}</div>
                  <button class="mini-btn" @click="$emit('retry-turn', turn.turnId)">重试本轮</button>
                </div>
              </template>
            </div>
          </div>
        </div>
      </template>

      <div v-if="turn.turnId && turn.turnId !== 'unknown'" class="turn-foot">
        <button class="mini-btn ghost" @click="$emit('delete-turn', turn.turnId)">删除本轮</button>

        <!-- Token 用量：只在拿到数据时显示 -->
        <span v-if="usageOf(turn)" class="usage-chip" :title="usageTitle(turn)">
          <span class="usage-total">{{ formatTokenUsage(totalTokenUsage(usageOf(turn))) }}</span>
          <span class="usage-detail">{{ usageText(usageOf(turn)) }}</span>
          <em v-if="usageOf(turn).estimated" class="usage-est">估算</em>
        </span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import SafeImage from './SafeImage.vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import {
  toolStatusKind, turnUsage, totalTokenUsage, formatTokenUsage, usageRows
} from '../timeline.js'

defineProps({ turns: { type: Array, default: () => [] } })
defineEmits(['preview', 'retry-turn', 'delete-turn'])

const openMap = ref(new Map())
function isOpen(id) {
  if (openMap.value.has(id)) return openMap.value.get(id)
  return false
}
function toggle(id) {
  const next = new Map(openMap.value)
  next.set(id, !isOpen(id))
  openMap.value = next
}

let seq = 0
const keyCache = new WeakMap()
function blockKey(block) {
  if (!block || typeof block !== 'object') return 'k' + (seq++)
  if (keyCache.has(block)) return keyCache.get(block)
  const k = block.id ?? ('b' + (seq++))
  keyCache.set(block, k)
  return k
}

function textOf(ev) {
  const c = ev?.content
  if (typeof c === 'string') return c
  // 多模态：content 是 parts 数组，只取文本部分
  if (Array.isArray(c)) {
    return c.filter(p => p && p.type === 'text').map(p => p.text).join('\n')
  }
  if (c && typeof c === 'object') return c.text || JSON.stringify(c)
  return ev?.summary || ''
}

/** 用户消息里的图片（来自事件 attachments） */
function eventImages(ev) {
  const list = ev?.attachments
  if (!Array.isArray(list)) return []
  return list.filter(a => a && a.is_image && a.data_url).map(a => a.data_url)
}

/** 用户消息里的非图片附件 */
function eventFiles(ev) {
  const list = ev?.attachments
  if (!Array.isArray(list)) return []
  return list.filter(a => a && !a.is_image)
}

function pretty(v) {
  if (v === undefined || v === null) return '（无）'
  if (typeof v === 'string') return v
  try {
    const s = JSON.stringify(v, null, 2)
    return s.length > 6000 ? s.slice(0, 6000) + '\n…（已截断）' : s
  } catch (_) { return String(v) }
}

function prettyResult(r) {
  if (r && typeof r === 'object' && r.error) return String(r.error)
  return pretty(r)
}

function argSummary(args) {
  if (!args || typeof args !== 'object') return typeof args === 'string' ? args.slice(0, 60) : ''
  const entries = Object.entries(args).slice(0, 2)
  return entries.map(([k, v]) => {
    let s = typeof v === 'string' ? v : JSON.stringify(v)
    if (s && s.length > 32) s = s.slice(0, 32) + '…'
    return `${k}=${s}`
  }).join(' ')
}

/** 从工具返回里提取图片（generate_image 的产物） */
/**
 * 从工具结果里取图片。
 * generate_image / edit_image 返回的 images 只带短 ID（不带 base64），
 * 这里返回 ID，由 resolveImage 从缓存异步取值。
 * 兼容旧数据：若直接带 data_url 则原样使用。
 */
function imagesOf(result) {
  if (!result || typeof result !== 'object') return []
  const out = []
  if (Array.isArray(result.images)) {
    for (const img of result.images) {
      if (!img || typeof img !== 'object') continue
      if (img.data_url || img.url) out.push({ src: img.data_url || img.url })
      else if (img.id) out.push({ id: img.id })
    }
  }
  if (result.data_url) out.push({ src: result.data_url })
  // read_image 的结果是顶层 id（不带 images 数组），同样要能显示
  if (!out.length && result.id && /^img_/.test(result.id)) out.push({ id: result.id })
  return out
}

/** 按 ID 从 IndexedDB 取图，结果缓存在本地 map 里避免重复查询 */
const imageSrcMap = ref({})

async function resolveImage(entry) {
  if (!entry) return ''
  if (entry.src) return entry.src
  if (!entry.id) return ''
  if (imageSrcMap.value[entry.id]) return imageSrcMap.value[entry.id]
  try {
    const row = await getImage(entry.id)
    const src = row?.data_url || ''
    if (src) imageSrcMap.value = { ...imageSrcMap.value, [entry.id]: src }
    return src
  } catch (_) {
    return ''
  }
}

function renderMarkdown(text) {
  const raw = String(text || '')
  if (!raw) return ''
  try {
    const html = marked.parse(raw, { breaks: true, gfm: true, async: false })
    return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } })
  } catch (_) {
    return DOMPurify.sanitize(raw.replace(/</g, '&lt;'))
  }
}

/**
 * 时间格式化：细到年月日时分秒。
 * 本地时区渲染（toISOString 是 UTC，直接用会差几个小时，容易误导）。
 */
function pad2(n) { return String(n).padStart(2, '0') }

function formatTime(value) {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} `
    + `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

/** 轨道行只显示时分秒，日期在同一天内是冗余的 */
function formatClock(value) {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

/** 取该轮的汇总用量（原版逻辑：有服务端数据用服务端，否则按字符估算） */
function usageOf(turn) {
  const u = turnUsage(turn)
  return u && (u.estimated || totalTokenUsage(u) > 0) ? u : null
}

/** 一行摘要：输入 / 输出 / 缓存，各家字段名不同，这里归一 */
function usageText(u) {
  if (!u) return ''
  const pick = (...keys) => {
    for (const k of keys) {
      const v = Number(u[k])
      if (Number.isFinite(v) && v > 0) return v
    }
    return 0
  }
  const input = pick('prompt_tokens', 'input_tokens')
  const output = pick('completion_tokens', 'output_tokens')
  const cacheRead = pick('cache_read_input_tokens', 'cached_input_tokens')
  const cacheWrite = pick('cache_creation_input_tokens')
  const reasoning = pick('reasoning_tokens')

  const parts = []
  if (input) parts.push(`入 ${input}`)
  if (output) parts.push(`出 ${output}`)
  if (cacheRead) parts.push(`缓存 ${cacheRead}`)
  if (cacheWrite) parts.push(`写缓存 ${cacheWrite}`)
  if (reasoning) parts.push(`推理 ${reasoning}`)
  if (u.estimated && u.estimated_tokens) parts.push(`约 ${u.estimated_tokens}`)
  return parts.join(' · ')
}

/** 悬停展示完整明细（含原始字段名，便于对照服务商文档） */
function usageTitle(turn) {
  const u = usageOf(turn)
  if (!u) return ''
  const rows = usageRows(u)
  if (!rows.length) return ''
  return rows.map((r) => `${r.key}: ${r.value}`).join('\n')
}

// toolStatusKind 保留引用，供未来样式扩展
void toolStatusKind
</script>

<style scoped>
.timeline { display: flex; flex-direction: column; gap: 26px; }
.turn { display: flex; flex-direction: column; gap: 10px; }

.user-row { display: flex; justify-content: flex-end; }
.user-bubble {
  max-width: min(78%, 640px);
  background: var(--accent-soft);
  padding: 10px 14px;
  border-radius: 12px 12px 3px 12px;
  white-space: pre-wrap;
  word-break: break-word;
}
.user-row.append .user-bubble { opacity: .82; border: 1px dashed var(--border-strong); }
.bubble-text { white-space: pre-wrap; word-break: break-word; }
.bubble-images { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.bubble-images figure { margin: 0; border-radius: 8px; overflow: hidden; border: 1px solid var(--border); }
.bubble-images img {
  display: block; max-width: 220px; max-height: 220px;
  object-fit: cover; cursor: zoom-in;
}
.bubble-files { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.bubble-time {
  margin-top: 5px; font-size: 10px; color: var(--muted);
  text-align: right; font-variant-numeric: tabular-nums; opacity: .8;
}
.file-chip {
  font-size: 11px; padding: 2px 7px;
  background: var(--panel); border: 1px solid var(--border);
  border-radius: 5px; color: var(--text-2);
}

.assistant-track { position: relative; display: flex; padding-left: 2px; }
.rail {
  position: absolute; left: 15px; top: 5px; bottom: 5px;
  width: 2px; background: var(--border); border-radius: 2px;
}
.rows { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; }

.row-head {
  display: flex; align-items: center; gap: 8px;
  width: 100%; padding: 4px 8px 4px 0;
  background: none; border: none; text-align: left;
  color: var(--text-2); border-radius: 6px;
}
.row-head:not(.static):hover { background: var(--panel-2); }
.row-head.static { cursor: default; }
.row-icon {
  flex: 0 0 26px; height: 26px;
  display: grid; place-items: center;
  background: var(--panel); border: 1px solid var(--border);
  border-radius: 7px; font-size: 12px; z-index: 1;
}
.row-title { font-weight: 500; white-space: nowrap; font-size: 13px; }
.row-sub {
  color: var(--muted); font-size: 12px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  flex: 1; min-width: 0;
}
.row-time {
  flex: 0 0 auto; font-size: 10px; color: var(--muted);
  font-variant-numeric: tabular-nums; opacity: .75;
}
.row-chevron { color: var(--muted); font-size: 10px; margin-left: auto; flex: 0 0 auto; }

.row-body { margin-left: 34px; padding: 2px 0 8px; }
.reply-body { margin-left: 34px; }
.closing-tag {
  display: inline-block; font-size: 11px; color: var(--muted);
  border: 1px solid var(--border); border-radius: 4px;
  padding: 0 6px; margin-bottom: 6px;
}

.reasoning-text, .simple-text {
  white-space: pre-wrap; word-break: break-word;
  color: var(--text-2); font-size: 13px;
  background: var(--panel-2); border: 1px solid var(--border);
  border-radius: 8px; padding: 10px 12px;
  max-height: 420px; overflow-y: auto;
}
.simple-text.err { color: var(--err); border-color: var(--err); }

.tool-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
@media (max-width: 720px) { .tool-grid { grid-template-columns: 1fr; } }
.tool-pane { min-width: 0; }
.pane-label { font-size: 11px; color: var(--muted); margin-bottom: 4px; }
.pane-code {
  margin: 0; padding: 8px 10px;
  background: var(--code-bg); border: 1px solid var(--border);
  border-radius: 8px; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  max-height: 280px; overflow: auto;
  white-space: pre-wrap; word-break: break-word;
}
.badge-err {
  background: var(--err); color: #fff;
  font-size: 10px; padding: 0 5px; border-radius: 4px; flex: 0 0 auto;
}

.tool-images { display: flex; flex-wrap: wrap; gap: 8px; margin: 6px 0 6px 34px; }
.tool-images figure { margin: 0; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.tool-images img { display: block; max-width: 240px; max-height: 240px; cursor: zoom-in; }

.note-row {
  margin-left: 34px; font-size: 12px; color: var(--muted);
  padding: 2px 0;
}

.cursor::after { content: '▍'; color: var(--accent); animation: blink 1s steps(1) infinite; }
@keyframes blink { 50% { opacity: 0 } }

.spinner {
  width: 12px; height: 12px; flex: 0 0 auto;
  border: 2px solid var(--border-strong);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin .7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg) } }

.turn-foot { display: flex; align-items: center; gap: 10px; padding-left: 34px; flex-wrap: wrap; }

/* token 用量 */
.usage-chip {
  display: inline-flex; align-items: baseline; gap: 6px;
  font-size: 11px; color: var(--muted);
  background: var(--bg); border: 1px solid var(--border);
  border-radius: 999px; padding: 1px 9px;
  cursor: default;
}
.usage-total { font-weight: 600; color: var(--text-2); }
.usage-detail { opacity: .85; }
.usage-est {
  font-style: normal; font-size: 10px;
  color: var(--warn); border-left: 1px solid var(--border);
  padding-left: 5px;
}
.mini-btn {
  font-size: 12px; padding: 2px 8px;
  background: var(--panel); color: var(--text-2);
  border: 1px solid var(--border); border-radius: 6px;
}
.mini-btn:hover { border-color: var(--accent); color: var(--accent); }
.mini-btn.ghost { border-color: transparent; background: transparent; color: var(--muted); }
.usage { font-size: 11px; color: var(--muted); margin-top: 6px; }

.markdown { line-height: 1.68; word-break: break-word; }
.markdown :deep(p) { margin: 0 0 .65em; }
.markdown :deep(p:last-child) { margin-bottom: 0; }
.markdown :deep(h1), .markdown :deep(h2), .markdown :deep(h3), .markdown :deep(h4) {
  margin: .8em 0 .4em; line-height: 1.3; font-weight: 600;
}
.markdown :deep(h1) { font-size: 1.3em; }
.markdown :deep(h2) { font-size: 1.18em; }
.markdown :deep(h3) { font-size: 1.06em; }
.markdown :deep(pre) {
  background: var(--code-bg); border: 1px solid var(--border);
  border-radius: 8px; padding: 10px 12px;
  overflow-x: auto; margin: .65em 0; font-size: 12.5px; line-height: 1.55;
}
.markdown :deep(code) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: .9em; background: var(--code-bg);
  padding: 1px 5px; border-radius: 4px;
}
.markdown :deep(pre code) { background: none; padding: 0; font-size: inherit; }
.markdown :deep(ul), .markdown :deep(ol) { margin: .5em 0; padding-left: 1.5em; }
.markdown :deep(li) { margin: .18em 0; }
.markdown :deep(a) { color: var(--accent); text-decoration: none; }
.markdown :deep(a:hover) { text-decoration: underline; }
.markdown :deep(blockquote) {
  margin: .6em 0; padding: .2em 0 .2em 12px;
  border-left: 3px solid var(--border-strong); color: var(--muted);
}
.markdown :deep(table) {
  border-collapse: collapse; margin: .65em 0; font-size: 13px;
  display: block; overflow-x: auto;
}
.markdown :deep(th), .markdown :deep(td) {
  border: 1px solid var(--border); padding: 5px 10px; text-align: left;
}
.markdown :deep(th) { background: var(--code-bg); font-weight: 600; }
.markdown :deep(hr) { border: none; border-top: 1px solid var(--border); margin: 1em 0; }
.markdown :deep(img) { max-width: 100%; border-radius: 8px; }
</style>
