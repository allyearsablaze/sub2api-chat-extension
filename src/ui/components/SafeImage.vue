<template>
  <img
    v-if="src"
    :src="src"
    loading="lazy"
    @click="$emit('preview', src)"
  />
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

const props = defineProps({
  entry: { type: Object, default: () => ({}) },
})
defineEmits(['preview'])

const resolved = ref('')
const loading = ref(false)

const src = computed(() => props.entry?.src || resolved.value)

async function load() {
  if (props.entry?.src) return
  const id = props.entry?.id
  if (!id) return
  loading.value = true
  try {
    const row = await getImage(id)
    resolved.value = row?.data_url || ''
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
.ph {
  width: 120px; height: 90px;
  display: grid; place-items: center;
  background: var(--bg); color: var(--muted);
  font-size: 11px; border-radius: 6px;
}
.spin { font-size: 16px; opacity: .6; }
.miss { opacity: .7; }
</style>
