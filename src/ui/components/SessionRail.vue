<template>
  <aside class="rail">
    <div class="rail-head">
      <span class="rail-title">会话</span>
      <button class="icon-btn" title="新建会话" @click="$emit('create')">＋</button>
    </div>

    <div class="rail-search">
      <input v-model="keyword" type="text" placeholder="搜索会话" />
    </div>

    <div class="rail-list">
      <div
        v-for="s in filtered"
        :key="s.id"
        class="session-item"
        :class="{ active: s.id === activeId, 'busy-locked': busy && s.id !== activeId }"
        :title="busy && s.id !== activeId ? '正在生成回复，暂不可切换' : ''"
        @click="$emit('select', s.id)"
      >
        <div class="item-copy">
          <div class="item-title" :title="s.title">{{ s.title }}</div>
          <div class="item-meta">
            <span class="item-model" :title="modelLabel(s)">{{ modelLabel(s) }}</span>
            <span v-if="s.messageCount" class="item-count">{{ s.messageCount }} 条</span>
          </div>
        </div>
        <div class="item-actions" @click.stop>
          <button class="icon-btn sm" title="重命名" @click="startRename(s)">✎</button>
          <button
            v-if="s.messageCount"
            class="icon-btn sm"
            title="清空消息（保留会话与设置）"
            @click="$emit('clear', s)"
          >⌫</button>
          <button class="icon-btn sm" title="删除会话" @click="$emit('remove', s)">✕</button>
        </div>
      </div>

      <div v-if="!filtered.length" class="rail-empty">
        {{ keyword ? '没有匹配的会话' : '还没有会话' }}
      </div>
    </div>

    <!-- 重命名弹层 -->
    <div v-if="renaming" class="rail-dialog" @click.self="renaming = null">
      <div class="dialog-body">
        <div class="dialog-title">重命名会话</div>
        <input
          ref="renameInput"
          v-model="renameText"
          type="text"
          @keydown.enter="confirmRename"
          @keydown.esc="renaming = null"
        />
        <div class="dialog-actions">
          <button class="btn" @click="renaming = null">取消</button>
          <button class="btn primary" @click="confirmRename">保存</button>
        </div>
      </div>
    </div>
  </aside>
</template>

<script setup>
import { ref, computed, nextTick } from 'vue'

const props = defineProps({
  sessions: { type: Array, default: () => [] },
  activeId: { type: [Number, String], default: null },
  busy: { type: Boolean, default: false },
})
const emit = defineEmits(['select', 'create', 'remove', 'rename', 'clear'])

/* 生成中时把其他会话标记为不可切换：
 * 点击仍会触发事件，由父组件统一拦截并提示，
 * 这里只做视觉提示，避免用户以为点了没反应。 */

const keyword = ref('')
const renaming = ref(null)
const renameText = ref('')
const renameInput = ref(null)

const filtered = computed(() => {
  const k = keyword.value.trim().toLowerCase()
  if (!k) return props.sessions
  return props.sessions.filter((s) => String(s.title || '').toLowerCase().includes(k))
})

function modelLabel(s) {
  return s.model_snapshot?.model_label || s.model_alias || '未配置模型'
}

async function startRename(s) {
  renaming.value = s
  renameText.value = s.title || ''
  await nextTick()
  renameInput.value?.focus()
  renameInput.value?.select()
}

function confirmRename() {
  const title = renameText.value.trim()
  if (renaming.value && title) {
    emit('rename', { session: renaming.value, title })
  }
  renaming.value = null
}
</script>

<style scoped>
.rail {
  width: 216px;
  flex: 0 0 216px;
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border-right: 1px solid var(--border);
  /* 重命名弹层是 absolute，需要定位上下文。
   * 但窄屏下外层要把它变成 fixed 抽屉——fixed 会被 position:relative 覆盖，
   * 所以用 :where 降低优先级，让外层样式能覆盖。 */
  position: relative;
  min-height: 0;
}
.rail-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 12px 6px;
}
.rail-title { font-weight: 600; font-size: 13px; }
.rail-search { padding: 0 10px 8px; }
.rail-search input {
  width: 100%; padding: 5px 9px; font-size: 12px;
  background: var(--bg); color: var(--text);
  border: 1px solid var(--border); border-radius: 7px; outline: none;
}
.rail-search input:focus { border-color: var(--accent); }

.rail-list { flex: 1; overflow-y: auto; padding: 0 6px 10px; min-height: 0; }

.session-item.busy-locked {
  opacity: .45; cursor: not-allowed;
}
.session-item.busy-locked:hover { background: transparent; }

.session-item {
  display: flex; align-items: center; gap: 6px;
  padding: 7px 8px; margin-bottom: 2px;
  border-radius: 8px; cursor: pointer;
  transition: background .12s;
}
.session-item:hover { background: var(--panel-2); }
.session-item.active { background: var(--accent-soft); }
.item-copy { flex: 1; min-width: 0; }
.item-title {
  font-size: 13px; font-weight: 500;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.item-meta {
  display: flex; gap: 7px; font-size: 11px; color: var(--muted);
  margin-top: 1px;
}
.item-model {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 110px;
}
.item-count { flex: 0 0 auto; }
.item-actions { display: flex; gap: 1px; opacity: 0; transition: opacity .12s; }
.session-item:hover .item-actions { opacity: 1; }

.icon-btn {
  border: none; background: transparent; color: var(--muted);
  border-radius: 6px; padding: 2px 7px; font-size: 14px; line-height: 1.4;
}
.icon-btn:hover { background: var(--bg); color: var(--accent); }
.icon-btn.sm { font-size: 12px; padding: 1px 5px; }

.rail-empty {
  text-align: center; color: var(--muted); font-size: 12px;
  padding: 24px 10px;
}

.rail-dialog {
  position: absolute; inset: 0; z-index: 20;
  background: rgba(0,0,0,.35);
  display: grid; place-items: center; padding: 14px;
}
.dialog-body {
  width: 100%; background: var(--panel);
  border: 1px solid var(--border); border-radius: 10px;
  padding: 14px; box-shadow: var(--shadow);
}
.dialog-title { font-size: 13px; font-weight: 600; margin-bottom: 10px; }
.dialog-body input {
  width: 100%; padding: 6px 9px; font-size: 13px;
  background: var(--bg); color: var(--text);
  border: 1px solid var(--border); border-radius: 7px; outline: none;
}
.dialog-body input:focus { border-color: var(--accent); }
.dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
.btn {
  font-size: 12px; padding: 4px 12px;
  background: var(--panel); color: var(--text);
  border: 1px solid var(--border); border-radius: 7px;
}
.btn:hover { border-color: var(--accent); color: var(--accent); }
.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }

/* 窄屏不再隐藏整块——外层用抽屉位移控制显隐，
 * 否则「新建会话」按钮也会跟着消失，手机端就无法建会话了。 */
@media (max-width: 760px) {
  /* 宽度由外层 .rail-wrap 决定（264px 抽屉），这里只放开弹性与边框 */
  .rail { flex: none; border-right: none; }
}
</style>
