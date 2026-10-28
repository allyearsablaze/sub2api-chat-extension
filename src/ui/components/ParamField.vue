<template>
  <!-- 下拉 -->
  <select v-if="field.type === 'select'" :value="value ?? ''" @change="emitValue($event.target.value)">
    <option value="">默认</option>
    <option v-for="o in field.options" :key="o" :value="o">{{ optionLabel(o) }}</option>
  </select>

  <!-- 布尔 -->
  <select
    v-else-if="field.type === 'boolean'"
    :value="value === true ? 'true' : value === false ? 'false' : ''"
    @change="emitValue($event.target.value === '' ? null : $event.target.value === 'true')"
  >
    <option value="">默认</option>
    <option value="true">开启</option>
    <option value="false">关闭</option>
  </select>

  <!-- 数字 -->
  <input
    v-else-if="field.type === 'number'"
    type="number"
    :min="field.min" :max="field.max" :step="field.step || 1"
    :value="value ?? ''"
    placeholder="默认"
    @input="emitValue($event.target.value === '' ? null : Number($event.target.value))"
  />

  <!-- 字符串列表 -->
  <input
    v-else-if="field.type === 'string-list'"
    type="text"
    :value="Array.isArray(value) ? value.join(', ') : ''"
    placeholder="逗号分隔"
    @change="emitList($event.target.value)"
  />

  <!-- JSON 对象 -->
  <textarea
    v-else-if="field.type === 'json-object'"
    rows="2"
    :value="jsonText"
    placeholder="JSON"
    @change="emitJson($event.target.value)"
  ></textarea>

  <!-- 工具选择 -->
  <select
    v-else-if="field.type === 'tool-choice'"
    :value="value ?? ''"
    @change="emitValue($event.target.value)"
  >
    <option value="">默认</option>
    <option value="auto">auto</option>
    <option value="required">required</option>
    <option value="none">none</option>
  </select>

  <!-- 多模态：多选 chip -->
  <div v-else-if="field.type === 'modality-list'" class="multi">
    <button
      v-for="m in MODALITY_VALUES"
      :key="m"
      class="chip"
      :class="{ on: currentModalities.includes(m) }"
      @click="toggleModality(m)"
    >{{ modalityLabel(m) }}</button>
  </div>

  <!-- 兜底 -->
  <input
    v-else
    type="text"
    :value="value ?? ''"
    placeholder="默认"
    @input="emitValue($event.target.value)"
  />
</template>

<script setup>
import { computed } from 'vue'
import {
  PARAM_OPTION_LABELS, paramOptionLabel, MODALITY_VALUES, modalityLabel
} from '../../engine/model/model_params.js'

const props = defineProps({
  field: { type: Object, required: true },
  value: { default: null },
})
const emit = defineEmits(['update'])

const jsonText = computed(() => {
  const v = props.value
  if (v === undefined || v === null) return ''
  try { return JSON.stringify(v, null, 2) } catch (_) { return '' }
})

function optionLabel(o) {
  return PARAM_OPTION_LABELS[`${props.field.key}:${o}`] || paramOptionLabel(o) || o
}

function emitValue(v) {
  emit('update', v === '' ? null : v)
}

function emitList(text) {
  const arr = String(text || '').split(',').map((s) => s.trim()).filter(Boolean)
  emit('update', arr.length ? arr : null)
}

function emitJson(text) {
  const t = String(text || '').trim()
  if (!t) return emit('update', null)
  try { emit('update', JSON.parse(t)) } catch (_) { /* 非法 JSON 保留原值 */ }
}

/* 多模态：至少保留一个，避免发空数组 */
const currentModalities = computed(() =>
  Array.isArray(props.value) && props.value.length ? props.value : ['text']
)

function toggleModality(m) {
  const cur = [...currentModalities.value]
  const i = cur.indexOf(m)
  if (i >= 0) cur.splice(i, 1)
  else cur.push(m)
  if (!cur.length) cur.push('text')
  emit('update', cur)
}
</script>

<style scoped>
select, input, textarea {
  width: 100%; padding: 5px 8px; font-size: 12.5px;
  background: var(--bg); color: var(--text);
  border: 1px solid var(--border); border-radius: 7px; outline: none;
  font-family: inherit;
}
textarea { resize: vertical; font-family: ui-monospace, Menlo, monospace; font-size: 12px; }
select:focus, input:focus, textarea:focus {
  border-color: var(--accent); box-shadow: 0 0 0 3px rgba(99,102,241,.12);
}

.multi { display: flex; flex-wrap: wrap; gap: 5px; }
.chip {
  font-size: 11.5px; padding: 3px 10px;
  background: var(--bg); color: var(--text-2);
  border: 1px solid var(--border); border-radius: 999px;
  cursor: pointer; transition: .14s;
}
.chip:hover { border-color: var(--accent); color: var(--accent); }
.chip.on {
  background: var(--accent); border-color: var(--accent);
  color: var(--accent-fg); font-weight: 500;
}
</style>
