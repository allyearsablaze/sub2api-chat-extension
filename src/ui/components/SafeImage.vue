<template>
  <div v-if="src" class="image-result">
    <img
      :src="src"
      loading="lazy"
      @click="$emit('preview', src)"
    />
    <div class="image-toolbar">
      <span class="format-label">{{ formatLabel }}</span>
      <button class="download" type="button" :disabled="downloading" aria-label="下载原图" title="下载原图" @click.stop="download">
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 2.5v9m-3-3 3 3 3-3M4 12.5V16h12v-3.5" /></svg>
        <span>{{ downloading ? '下载中…' : '下载原图' }}</span>
      </button>
    </div>
    <span v-if="downloadError" class="download-error">{{ downloadError }}</span>
  </div>
  <div v-else class="ph" :title="entry?.id || ''">
    <span v-if="loading" class="spin">⋯</span>
    <span v-else class="miss">图片已清理</span>
  </div>
</template>

<script setup>
/**
 * 按图片 ID 异步取图并渲染。
 * 工具结果里只有短 ID（避免 base64 进上下文），真正的图存在 image_cache 表。
 */
import { ref, computed, onMounted, watch } from 'vue'
import { getImage } from '../../engine/repository/image_cache.js'
import { imageExtension, detectImageMime, normalizeImageDataUrl } from '../../engine/common/image.js'

const props = defineProps({
  entry: { type: Object, default: () => ({}) },
})
defineEmits(['preview'])

const resolved = ref('')
const loading = ref(false)
const mime = ref('')
const downloading = ref(false)
const downloadError = ref('')

const src = computed(() => {
  const value = props.entry?.src || resolved.value
  return value?.startsWith('data:') ? normalizeImageDataUrl(value).data_url : value
})
const formatLabel = computed(() => {
  const type = /^data:([^;,]+)/.exec(src.value || '')?.[1] || mime.value || props.entry?.mime
  return type ? imageExtension(type).toUpperCase() : ''
})

async function download() {
  downloading.value = true
  downloadError.value = ''
  let objectUrl
  try {
    const response = await fetch(src.value)
    if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    const actualMime = detectImageMime(bytes)
    const blob = new Blob([bytes], { type: actualMime })
    objectUrl = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = objectUrl
    link.download = `${props.entry?.id || 'image'}.${imageExtension(actualMime)}`
    link.click()
  } catch (error) {
    downloadError.value = error.message
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl)
    downloading.value = false
  }
}

async function load() {
  if (props.entry?.src) return
  const id = props.entry?.id
  if (!id) return
  loading.value = true
  try {
    const row = await getImage(id)
    resolved.value = row?.data_url || ''
    mime.value = row?.mime || ''
  } catch (_) {
    resolved.value = ''
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(() => props.entry?.id, load)
</script>

<style scoped>
img { display: block; max-width: 240px; max-height: 240px; cursor: zoom-in; }
.image-result { display: flex; flex-direction: column; min-width: 144px; max-width: 240px; background: var(--panel); }
.image-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; padding: 6px 8px; border-top: 1px solid var(--border); }
.format-label { color: var(--muted); font-size: 10px; font-weight: 600; letter-spacing: .06em; }
.download { display: inline-flex; align-items: center; gap: 4px; padding: 4px 7px; border: 1px solid transparent; border-radius: 6px; color: var(--text-2); background: transparent; font-size: 11px; line-height: 1.4; transition: background .15s, color .15s; }
.download svg { width: 15px; height: 15px; }
.download:hover { color: var(--accent); background: var(--accent-soft); }
.download:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.download:disabled { opacity: .55; cursor: wait; }
.download-error { padding: 4px; color: var(--muted); font-size: 12px; }
.ph {
  width: 120px; height: 90px;
  display: grid; place-items: center;
  background: var(--bg); color: var(--muted);
  font-size: 11px; border-radius: 6px;
}
.spin { font-size: 16px; opacity: .6; }
.miss { opacity: .7; }
</style>
