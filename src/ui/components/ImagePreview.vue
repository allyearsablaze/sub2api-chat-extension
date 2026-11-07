<template>
  <Teleport to="body">
    <div class="image-overlay" @click.self="$emit('close')">
      <section ref="dialog" class="image-preview" role="dialog" aria-modal="true" aria-label="图片预览" tabindex="-1" @keydown.esc.stop="$emit('close')" @keydown.tab.prevent="closeButton?.focus()">
        <header>
          <span>图片预览</span>
          <button ref="closeButton" type="button" aria-label="关闭预览" title="关闭（Esc）" @click="$emit('close')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6" /></svg>
          </button>
        </header>
        <div class="image-stage"><img :src="src" alt="预览" /></div>
        <footer>点击空白区域或按 Esc 关闭</footer>
      </section>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'

defineProps({ src: { type: String, required: true } })
defineEmits(['close'])
const dialog = ref(null)
const closeButton = ref(null)
let previousFocus
onMounted(() => {
  previousFocus = document.activeElement
  dialog.value?.focus()
})
onBeforeUnmount(() => previousFocus?.focus())
</script>

<style scoped>
.image-overlay { position: fixed; inset: 0; z-index: 200; display: grid; place-items: center; padding: 28px; background: rgba(9, 13, 24, .72); backdrop-filter: blur(6px); }
.image-preview { width: fit-content; max-width: min(960px, 90vw); max-height: 88dvh; overflow: hidden; outline: none; border: 1px solid var(--border); border-radius: 16px; background: var(--panel); box-shadow: 0 24px 80px rgba(0, 0, 0, .3); }
header { display: flex; align-items: center; justify-content: space-between; gap: 40px; padding: 10px 14px 10px 18px; color: var(--text); font-size: 13px; font-weight: 600; }
button { display: grid; place-items: center; width: 32px; height: 32px; padding: 6px; border: 0; border-radius: 8px; background: transparent; color: var(--muted); }
button:hover { color: var(--text); background: var(--bg); }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
button svg { width: 20px; height: 20px; }
.image-stage { display: flex; justify-content: center; padding: 12px; background: var(--bg); }
.image-stage img { display: block; width: auto; height: auto; max-width: min(900px, calc(90vw - 26px)); max-height: 68dvh; object-fit: contain; border-radius: 6px; }
footer { padding: 9px 18px; text-align: center; color: var(--muted); font-size: 11px; }
@media (max-width: 640px) {
  .image-overlay { padding: 12px; }
  .image-preview { max-width: calc(100vw - 24px); }
  .image-stage { padding: 8px; }
  .image-stage img { max-width: calc(100vw - 42px); max-height: 64dvh; }
}
</style>
