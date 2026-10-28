<template>
  <div class="composer">
   <div class="composer-inner">
    <!-- 执行中 / 排队卡片 -->
    <div v-if="runningTask || queuedTasks.length" class="task-panel">
      <div v-if="runningTask" class="task-card running">
        <span class="task-badge running">处理中</span>
        <span class="task-text" :title="runningTask.content">{{ summary(runningTask) }}</span>
        <span v-if="imageModel" class="task-model">{{ imageModel }}</span>
        <span class="spacer"></span>
        <button class="mini-btn" @click="$emit('stop')">停止</button>
      </div>

      <div v-for="t in queuedTasks" :key="t.id" class="task-card queued">
        <span class="task-badge">排队</span>
        <span class="task-text" :title="t.content">{{ summary(t) }}</span>
        <span class="spacer"></span>
        <button class="mini-btn" @click="startEdit(t)">编辑</button>
        <button class="mini-btn danger" @click="$emit('cancel-queued', t)">取消</button>
      </div>
    </div>

    <!-- 编辑排队消息 -->
    <div v-if="editing" class="edit-sheet">
      <div class="edit-head">
        <span>编辑排队消息</span>
        <button class="mini-btn ghost" @click="editing = null">取消</button>
      </div>
      <textarea v-model="editText" rows="3" @keydown.esc="editing = null"></textarea>
      <div class="edit-actions">
        <button class="mini-btn primary" @click="confirmEdit">保存</button>
      </div>
    </div>

    <!-- 附件预览条 -->
    <div v-if="attachments.length" class="attach-strip">
      <div v-for="a in attachments" :key="a.id" class="attach-chip">
        <img v-if="isImage(a)" :src="a.data_url" alt="" />
        <span v-else class="file-icon">📄</span>
        <div class="chip-copy">
          <span class="chip-name" :title="a.file_name">{{ a.file_name }}</span>
          <span class="chip-size">{{ formatSize(a.size) }}</span>
        </div>
        <button class="chip-x" title="移除" @click="removeAttachment(a.id)">✕</button>
      </div>
    </div>

    <!-- 输入区 -->
    <div class="input-row" @paste="onPaste" @dragover.prevent="dragging = true" @dragleave="dragging = false" @drop.prevent="onDrop">
      <textarea
        ref="inputEl"
        v-model="draft"
        rows="1"
        :placeholder="placeholder"
        :disabled="disabled"
        @input="autoGrow"
        @keydown="onKeydown"
      ></textarea>
      <div class="input-actions">
        <button class="icon-btn" title="添加附件" :disabled="disabled" @click="fileInput?.click()">📎</button>
        <input ref="fileInput" class="hidden-file" type="file" multiple @change="onFiles" />
        <button
          v-if="isRunning"
          class="btn warn"
          title="停止当前生成"
          @click="$emit('stop')"
        >停止</button>
        <button
          class="btn primary"
          :disabled="!canSend"
          :title="isRunning ? '当前回复完成后执行' : '发送'"
          @click="submit"
        >{{ isRunning ? '排队' : '发送' }}</button>
      </div>
    </div>

    <div class="foot-hint">
      <span class="status">{{ statusText }}</span>
      <span class="spacer"></span>
      <span v-if="dragging" class="drop-hint">松开以添加附件</span>
      <span v-else class="kbd-hint">⌘/Ctrl + Enter 发送 · 可直接粘贴图片</span>
    </div>
   </div>
  </div>
</template>

<script setup>
import { ref, computed, nextTick, watch } from 'vue'
import { consumeClipboardAttachments, prepareAttachment, isImageFile, formatSize } from '../attachment.js'

const props = defineProps({
  disabled: { type: Boolean, default: false },
  isRunning: { type: Boolean, default: false },
  runningTask: { type: Object, default: null },
  queuedTasks: { type: Array, default: () => [] },
  imageModel: { type: String, default: '' },
  statusText: { type: String, default: '' },
  placeholder: { type: String, default: '输入消息…' },
})
const emit = defineEmits(['send', 'stop', 'cancel-queued', 'edit-queued'])

const draft = ref('')
const attachments = ref([])
const editing = ref(null)
const editText = ref('')
const dragging = ref(false)
const inputEl = ref(null)
const fileInput = ref(null)

const canSend = computed(() =>
  !props.disabled && (draft.value.trim().length > 0 || attachments.value.length > 0)
)

function isImage(a) { return String(a.content_type || '').startsWith('image/') }
function summary(t) {
  const c = String(t?.content || '').replace(/\s+/g, ' ').trim()
  return c || `${(t?.attachment_ids || []).length} 个附件`
}

function autoGrow() {
  const el = inputEl.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 200) + 'px'
}

async function addFiles(files) {
  for (const f of files) {
    try {
      const a = await prepareAttachment(f)
      if (a) attachments.value.push(a)
    } catch (e) {
      emit('send', { __error: e.message })
    }
  }
}

async function onFiles(e) {
  const files = [...(e.target.files || [])]
  e.target.value = ''    // 允许重复选同一文件
  await addFiles(files)
}

async function onPaste(e) {
  const files = consumeClipboardAttachments(e)
  if (files.length) await addFiles(files)
}

async function onDrop(e) {
  dragging.value = false
  const files = [...(e.dataTransfer?.files || [])]
  if (files.length) await addFiles(files)
}

function removeAttachment(id) {
  attachments.value = attachments.value.filter((a) => a.id !== id)
}

function submit() {
  if (!canSend.value) return
  const text = draft.value.trim()
  const attachments_ = attachments.value.slice()
  draft.value = ''
  attachments.value = []
  autoGrow()
  emit('send', { content: text, attachments: attachments_ })
  nextTick(() => autoGrow())
}

function onKeydown(e) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault()
    submit()
  }
}

function startEdit(t) {
  editing.value = t
  editText.value = t.content || ''
}
function confirmEdit() {
  if (!editing.value) return
  emit('edit-queued', { task: editing.value, content: editText.value.trim() })
  editing.value = null
}

// 供父组件在切换会话时清空草稿
defineExpose({
  clearDraft() {
    draft.value = ''
    attachments.value = []
    editing.value = null
    autoGrow()
  },
  focus() { inputEl.value?.focus() },
})

watch(() => props.disabled, (v) => { if (!v) nextTick(() => autoGrow()) })
</script>

<style scoped>
.composer {
  flex: 0 0 auto;
  border-top: 1px solid var(--border);
  background: var(--panel);
  padding: 8px 16px 9px;
}
/* 与消息区（.wrap 900px）同宽，左右边缘对齐 */
.composer-inner {
  /* 与消息区同宽（满宽），保证左右边缘严格对齐 */
  width: 100%;
}

/* 任务卡片 */
.task-panel {
  display: flex; flex-direction: column; gap: 5px;
  margin-bottom: 8px;
}
.task-card {
  display: flex; align-items: center; gap: 8px;
  padding: 5px 10px; font-size: 12px;
  border: 1px solid var(--border); border-radius: 8px;
  background: var(--panel-2);
}
.task-card.running { border-color: var(--accent); }
.task-badge {
  flex: 0 0 auto; font-size: 10px; padding: 1px 6px; border-radius: 4px;
  background: var(--border); color: var(--muted);
}
.task-badge.running { background: var(--accent); color: var(--accent-fg); }
.task-text {
  flex: 1; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--text-2);
}
.task-model {
  flex: 0 0 auto; font-size: 10px; color: var(--muted);
  border: 1px solid var(--border); border-radius: 4px; padding: 0 5px;
}
.spacer { flex: 1 1 auto; }
.mini-btn {
  flex: 0 0 auto; font-size: 11px; padding: 1px 8px;
  background: var(--panel); color: var(--text-2);
  border: 1px solid var(--border); border-radius: 5px; cursor: pointer;
}
.mini-btn:hover { border-color: var(--accent); color: var(--accent); }
.mini-btn.danger:hover { border-color: var(--err); color: var(--err); }
.mini-btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
.mini-btn.ghost { border-color: transparent; background: transparent; color: var(--muted); }

/* 编辑弹层 */
.edit-sheet {
  margin-bottom: 8px; padding: 10px;
  border: 1px solid var(--accent); border-radius: 8px;
  background: var(--panel-2);
}
.edit-head {
  display: flex; justify-content: space-between; align-items: center;
  font-size: 12px; color: var(--muted); margin-bottom: 6px;
}
.edit-sheet textarea {
  width: 100%; resize: vertical; min-height: 60px;
  padding: 7px 9px; font: inherit; font-size: 13px;
  background: var(--panel); color: var(--text);
  border: 1px solid var(--border); border-radius: 7px; outline: none;
}
.edit-sheet textarea:focus { border-color: var(--accent); }
.edit-actions { display: flex; justify-content: flex-end; margin-top: 6px; }

/* 附件条 */
.attach-strip {
  display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px;
}
.attach-chip {
  display: flex; align-items: center; gap: 7px;
  padding: 4px 7px 4px 4px; max-width: 220px;
  border: 1px solid var(--border); border-radius: 8px;
  background: var(--panel-2);
}
.attach-chip img {
  width: 32px; height: 32px; object-fit: cover;
  border-radius: 5px; flex: 0 0 32px;
}
.file-icon { width: 32px; text-align: center; font-size: 17px; flex: 0 0 32px; }
.chip-copy { display: flex; flex-direction: column; min-width: 0; }
.chip-name {
  font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.chip-size { font-size: 10px; color: var(--muted); }
.chip-x {
  flex: 0 0 auto; border: none; background: transparent;
  color: var(--muted); cursor: pointer; font-size: 11px; padding: 2px 4px;
}
.chip-x:hover { color: var(--err); }

/* 输入 */
.input-row {
  display: flex; gap: 8px; align-items: flex-end;
  border: 1px solid var(--border); border-radius: 11px;
  padding: 6px 6px 6px 4px; background: var(--panel);
  transition: border-color .15s, box-shadow .15s;
}
.input-row:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(99,102,241,.13);
}
.input-row textarea {
  flex: 1; resize: none; min-height: 34px; max-height: 200px;
  padding: 7px 8px; line-height: 1.5;
  background: transparent; color: var(--text);
  border: none; outline: none; font-family: inherit; font-size: 14px;
}
.input-actions { display: flex; align-items: center; gap: 4px; padding-bottom: 1px; }
.icon-btn {
  border: none; background: transparent; color: var(--muted);
  border-radius: 7px; padding: 5px 7px; font-size: 15px; cursor: pointer;
}
.icon-btn:hover:not(:disabled) { background: var(--bg); color: var(--accent); }
.icon-btn:disabled { opacity: .4; cursor: not-allowed; }
.hidden-file { display: none; }

.btn {
  font-size: 13px; padding: 6px 16px; border-radius: 8px;
  border: 1px solid var(--border); background: var(--panel); color: var(--text);
  cursor: pointer; transition: .15s;
}
.btn:disabled { opacity: .45; cursor: not-allowed; }
.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
.btn.primary:hover:not(:disabled) { filter: brightness(1.08); }
.btn.warn { background: var(--err); border-color: var(--err); color: #fff; }

.foot-hint {
  display: flex; align-items: center; gap: 8px;
  margin-top: 6px; font-size: 11px; color: var(--muted);
}
.kbd-hint { opacity: .8; }
.drop-hint { color: var(--accent); font-weight: 500; }
</style>
