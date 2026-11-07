<template>
  <div v-if="src" class="image-result">
    <img
      :src="src"
      loading="lazy"
      @click="$emit('preview', src)"
    />
    <button class="download" type="button" :disabled="downloading" @click.stop="download">{{ downloading ? '下载中…' : '下载原图' }}</button>
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
import { imageExtension } from '../../engine/common/image.js'

const props = defineProps({
  entry: { type: Object, default: () => ({}) },
})
defineEmits(['preview'])

const resolved = ref('')
const loading = ref(false)
const mime = ref('')
const downloading = ref(false)
const downloadError = ref('')

const src = computed(() => props.entry?.src || resolved.value)

async function download() {
  downloading.value = true
  downloadError.value = ''
  let objectUrl
  try {
    const response = await fetch(src.value)
    if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`)
    const blob = await response.blob()
    objectUrl = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = objectUrl
    link.download = `${props.entry?.id || 'image'}.${imageExtension(mime.value || props.entry?.mime || blob.type)}`
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
.image-result { display: flex; flex-direction: column; align-items: flex-start; }
.download { margin: 4px; font-size: 12px; cursor: pointer; }
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
