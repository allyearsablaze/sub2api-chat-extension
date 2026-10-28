<template>
  <div v-if="open" class="mask" @click.self="$emit('close')">
    <div class="dialog">
      <header class="dlg-head">
        <div>
          <div class="dlg-title">模型参数</div>
          <div class="dlg-sub">{{ protocolLabel }}<span v-if="modelLabel"> · {{ modelLabel }}</span></div>
        </div>
        <button class="x" @click="$emit('close')">✕</button>
      </header>

      <div class="dlg-body">
        <!-- API 协议：不同协议支持的字段不同，必须显式选择 -->
        <section class="group">
          <div class="group-head"><span>API 协议</span></div>
          <div class="proto-row">
            <button
              v-for="p in protocolOptions"
              :key="p.value"
              class="proto-btn"
              :class="{ active: protocol === p.value }"
              :disabled="providerKind === 'anthropic' && p.value !== 'messages'"
              @click="$emit('change-protocol', p.value)"
            >
              <span class="proto-name">{{ p.label }}</span>
              <span class="proto-desc">{{ p.desc }}</span>
            </button>
          </div>
          <div class="hint">
            协议决定可用参数：<b>chat completions</b> 用 <code>max_completion_tokens</code> +
            <code>reasoning_effort</code>；<b>responses</b> 用 <code>max_output_tokens</code> +
            <code>reasoning.effort</code>；<b>messages</b> 用 <code>max_tokens</code> +
            <code>thinking.budget_tokens</code>。选错会 400。
          </div>
        </section>

        <!-- 会话运行时 -->
        <section class="group">
          <div class="group-head">
            <span>运行配置</span>
            <span class="group-count" v-if="runtimeSetCount">{{ runtimeSetCount }} 项已设置</span>
          </div>
          <div class="grid">
            <label
              v-for="f in runtimeFields.filter((x) => x.type !== 'modality-list')"
              :key="f.key"
              class="field"
              :title="f.help"
            >
              <span class="label">{{ f.title }}<em class="mono">{{ f.label }}</em></span>
              <input
                type="number"
                :min="f.min" :max="f.max" :step="f.step"
                :value="runtimeValues[f.key]"
                :placeholder="placeholderFor(f)"
                @input="onRuntimeInput(f, $event)"
              />
            </label>

            <!-- 模态独占整行：chip 横向排列，不会被挤到下一行 -->
            <div
              v-if="modalityField"
              class="field field-wide"
              :title="modalityField.help"
            >
              <span class="label">{{ modalityField.title }}<em class="mono">{{ modalityField.label }}</em></span>
              <ParamField
                :field="modalityField"
                :value="runtimeValues.modalities"
                @update="runtimeValues = { ...runtimeValues, modalities: $event || ['text'] }"
              />
            </div>
          </div>
          <div class="hint">
            留空表示使用默认值。上下文窗口用于估算历史裁剪；「输入模态」勾选图片后，
            才会把图片作为 image_url 发给模型。
          </div>
        </section>

        <!-- 常用参数：直接平铺 -->
        <section v-if="commonFields.length" class="group">
          <div class="group-head"><span>常用参数</span></div>
          <div class="grid">
            <div v-for="f in commonFields" :key="f.key" class="field" :title="helpOf(f)">
              <span class="label">{{ titleOf(f) }}<em class="mono">{{ f.key }}</em></span>
              <ParamField
                :field="f"
                :value="paramValues[f.key]"
                @update="setParam(f.key, $event)"
              />
            </div>
          </div>
        </section>

        <!-- 执行参数：工具循环相关 -->
        <section v-if="execFields.length" class="group">
          <div class="group-head"><span>执行控制</span></div>
          <div class="grid">
            <label v-for="f in execFields" :key="f.key" class="field" :title="f.help">
              <span class="label">{{ f.title }}<em class="mono">{{ f.label }}</em></span>
              <input
                type="number"
                :min="f.min" :max="f.max" :step="f.step || 1"
                :value="executionValues[f.key]"
                placeholder="默认"
                @input="onExecInput(f, $event)"
              />
            </label>
          </div>
          <div class="hint">
            图片生成（180 秒）与图片编辑（240 秒）有独立超时，不受「工具超时」影响。
          </div>
        </section>

        <!-- 高级参数：折叠 -->
        <section v-if="advancedFieldCount" class="group">
          <button class="adv-toggle" @click="advancedOpen = !advancedOpen">
            <span class="adv-caret">{{ advancedOpen ? '▾' : '▸' }}</span>
            <span class="adv-title">高级参数</span>
            <span class="adv-meta">
              {{ advancedFieldCount }} 项
              <em v-if="advancedSetCount" class="adv-set">{{ advancedSetCount }} 项已设置</em>
            </span>
          </button>

          <div v-if="advancedOpen" class="adv-body">
            <div v-for="grp in advancedGroups" :key="grp.name" class="adv-group">
              <div class="adv-group-head">
                <span>{{ grp.title }}</span>
                <span v-if="grp.setCount" class="group-count">{{ grp.setCount }} 项已设置</span>
              </div>
              <div class="grid">
                <div v-for="f in grp.fields" :key="f.key" class="field" :title="helpOf(f)">
                  <span class="label">{{ titleOf(f) }}<em class="mono">{{ f.key }}</em></span>
                  <ParamField
                    :field="f"
                    :value="paramValues[f.key]"
                    @update="setParam(f.key, $event)"
                  />
                </div>
              </div>
            </div>
          </div>
        </section>

      </div>

      <footer class="dlg-foot">
        <button class="btn" @click="resetAll">全部重置</button>
        <span class="spacer"></span>
        <button class="btn" @click="$emit('close')">取消</button>
        <button class="btn primary" @click="save">保存</button>
      </footer>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import ParamField from './ParamField.vue'
import {
  modelParamFields, groupTitle, PARAM_FIELD_TITLES, PARAM_FIELD_HELP,
  API_PROTOCOL_LABELS, SESSION_RUNTIME_FIELDS, EXECUTION_PARAM_FIELDS
} from '../../engine/model/model_params.js'

const props = defineProps({
  open: { type: Boolean, default: false },
  protocol: { type: String, default: 'completions' },   // completions / responses / messages
  providerKind: { type: String, default: 'openai-compatible' },
  modelLabel: { type: String, default: '' },
  modelParams: { type: Object, default: () => ({}) },
  runtime: { type: Object, default: () => ({}) },       // context_window 等
  execution: { type: Object, default: () => ({}) },     // max_tool_call_rounds 等
})
const emit = defineEmits(['close', 'save', 'change-protocol'])

/* 三种协议的差异：
 *   completions —— OpenAI Chat Completions，字段最全（max_completion_tokens）
 *   responses   —— OpenAI Responses API，用 max_output_tokens / reasoning.effort
 *   messages    —— Anthropic Messages，用 max_tokens / thinking.budget_tokens
 * 各协议字段集由 modelParamFields 按 protocol 返回，这里只负责让用户选。 */
const protocolOptions = [
  { value: 'completions', label: 'Chat Completions', desc: 'OpenAI / 兼容端点最常用' },
  { value: 'responses',   label: 'Responses',        desc: 'OpenAI 新版，支持 reasoning 摘要' },
  { value: 'messages',    label: 'Messages',         desc: 'Anthropic 原生协议' },
]

const paramValues = ref({})
const runtimeValues = ref({})
const executionValues = ref({})
const advancedOpen = ref(false)

const protocolLabel = computed(() => API_PROTOCOL_LABELS[props.protocol] || props.protocol)

/* 只暴露需要的运行参数：
 *   context_window —— 有用（控制历史裁剪预算）
 *   modalities     —— 有用（多模态开关）
 * 隐藏 max_history_messages 与 history_token_ratio：这两个是内部裁剪细节，
 * 暴露给用户只会造成困扰，默认值已经够用。 */
const HIDDEN_RUNTIME_KEYS = new Set(['max_history_messages', 'history_token_ratio'])
const runtimeFields = computed(() =>
  SESSION_RUNTIME_FIELDS.filter((f) => !HIDDEN_RUNTIME_KEYS.has(f.key))
)
const modalityField = computed(() => SESSION_RUNTIME_FIELDS.find((f) => f.type === 'modality-list'))
const execFields = computed(() => EXECUTION_PARAM_FIELDS)

const allFields = computed(() => {
  const kind = props.providerKind === 'anthropic' ? 'anthropic' : 'openai'
  // 第三参数固定 false：不追加 thinking / output_config 等第三方私有字段。
  // sub2api 的 openai 族走标准 OpenAI 协议，填这些字段会被上游 400。
  return modelParamFields(kind, props.protocol, false)
})

/** 常用字段：字段表里标了 common 的，直接平铺，不打折 */
const commonFields = computed(() =>
  allFields.value.filter((f) => f.common && visible(f))
)

/** 高级字段：其余全部按分组收进折叠区 */
const advancedGroups = computed(() => {
  const map = new Map()
  for (const f of allFields.value) {
    if (f.common) continue
    if (!visible(f)) continue
    const g = f.group || 'advanced'
    if (!map.has(g)) map.set(g, { name: g, title: groupTitle(g), fields: [] })
    map.get(g).fields.push(f)
  }
  const order = ['sampling', 'limits', 'reasoning', 'structuredOutput', 'tools', 'streamingCache', 'advanced']
  const out = [...map.values()].sort(
    (a, b) => (order.indexOf(a.name) + 1 || 99) - (order.indexOf(b.name) + 1 || 99)
  )
  for (const grp of out) {
    grp.setCount = grp.fields.filter((f) => isSet(f.key)).length
  }
  return out
})

const advancedFieldCount = computed(() =>
  advancedGroups.value.reduce((sum, g) => sum + g.fields.length, 0)
)
const advancedSetCount = computed(() =>
  advancedGroups.value.reduce((sum, g) => sum + g.setCount, 0)
)

function isSet(key) {
  const v = paramValues.value[key]
  return v !== null && v !== undefined && v !== ''
}

const runtimeSetCount = computed(() =>
  Object.values(runtimeValues.value).filter((v) => v !== null && v !== undefined && v !== '').length
)

function titleOf(f) { return PARAM_FIELD_TITLES[f.key] || f.key }
function helpOf(f) { return PARAM_FIELD_HELP[f.key] || '' }
function placeholderFor(f) {
  if (f.key === 'context_window') return '默认 32000'
  if (f.key === 'history_token_ratio') return '默认 0.35'
  return '默认'
}

/** 多模态多选：勾选即加入数组，取消即移除；全空时回落到默认 ['text'] */
function setParam(key, value) {
  const next = { ...paramValues.value }
  if (value === null || value === undefined || value === '') delete next[key]
  else next[key] = value
  paramValues.value = next
}

function onRuntimeInput(f, e) {
  const raw = e.target.value
  const next = { ...runtimeValues.value }
  if (raw === '') delete next[f.key]
  else next[f.key] = Number(raw)
  runtimeValues.value = next
}

function onExecInput(f, e) {
  const raw = e.target.value
  const next = { ...executionValues.value }
  if (raw === '') delete next[f.key]
  else next[f.key] = Number(raw)
  executionValues.value = next
}

/**
 * showWhen 支持两种写法：
 *   { key, value }   —— 单值匹配
 *   { key, values }  —— 多值匹配（如 thinking.type ∈ [enabled, adaptive]）
 * 早期只处理了 value，导致 thinking.budget_tokens 这类多值条件永远不显示。
 */
function visible(f) {
  if (!f.showWhen) return true
  const cur = paramValues.value[f.showWhen.key]
  const current = cur === undefined || cur === null ? '' : String(cur)
  if (Array.isArray(f.showWhen.values)) {
    return f.showWhen.values.map(String).includes(current)
  }
  return current === String(f.showWhen.value ?? '')
}

function syncFromProps() {
  // 扁平化：'response_format.type' 这种键在存储里就是扁平键
  paramValues.value = { ...(props.modelParams || {}) }
  runtimeValues.value = {
    ...(props.runtime || {}),
    // 默认至少勾上 text，让用户一眼看出这是可多选的
    modalities: Array.isArray(props.runtime?.modalities) && props.runtime.modalities.length
      ? [...props.runtime.modalities]
      : ['text'],
  }
  executionValues.value = { ...(props.execution || {}) }
}

watch(() => props.open, (v) => { if (v) syncFromProps() }, { immediate: true })

/* 面板打开期间切换会话 / 改模型时也要同步，
 * 否则会拿旧会话的值继续编辑，保存后把新会话的配置覆盖掉。 */
watch(
  () => [props.modelParams, props.runtime, props.execution],
  () => { if (props.open) syncFromProps() },
  { deep: true }
)

function resetAll() {
  paramValues.value = {}
  runtimeValues.value = {}
  executionValues.value = {}
}

function save() {
  const runtime = { ...runtimeValues.value }
  if (Array.isArray(runtime.modalities) && !runtime.modalities.length) runtime.modalities = ['text']
  emit('save', {
    modelParams: { ...paramValues.value },
    runtime,
    execution: { ...executionValues.value },
  })
  emit('close')
}

// 供父组件展开高级参数时使用
defineExpose({ execFields })
</script>

<style scoped>
.mask {
  position: fixed; inset: 0; z-index: 80;
  background: rgba(0,0,0,.45);
  display: grid; place-items: center; padding: 24px;
}
.dialog {
  width: min(760px, 100%);
  max-height: min(86vh, 820px);
  display: flex; flex-direction: column;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: 0 20px 60px rgba(0,0,0,.28);
  overflow: hidden;
}
.dlg-head {
  flex: 0 0 auto;
  display: flex; align-items: flex-start; justify-content: space-between;
  padding: 15px 18px 12px;
  border-bottom: 1px solid var(--border);
}
.dlg-title { font-size: 15px; font-weight: 600; }
.dlg-sub { font-size: 12px; color: var(--muted); margin-top: 2px; }
.x {
  border: none; background: transparent; color: var(--muted);
  font-size: 15px; padding: 2px 7px; border-radius: 6px; cursor: pointer;
}
.x:hover { background: var(--bg); color: var(--text); }

.dlg-body { flex: 1; overflow-y: auto; padding: 14px 18px 4px; }

.group { margin-bottom: 18px; }
.group-head {
  display: flex; align-items: center; gap: 8px;
  font-size: 12px; font-weight: 600; color: var(--text-2);
  padding-bottom: 6px; margin-bottom: 9px;
  border-bottom: 1px dashed var(--border);
}
.group-count {
  font-weight: 400; font-size: 11px; color: var(--accent);
  background: var(--accent-soft); padding: 1px 7px; border-radius: 999px;
}

.grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  gap: 10px 14px;
}
/* 独占整行的字段（模态多选） */
.field-wide { grid-column: 1 / -1; }

/* 高级参数折叠 */
.adv-toggle {
  display: flex; align-items: center; gap: 7px;
  width: 100%; padding: 7px 9px;
  background: var(--bg); color: var(--text-2);
  border: 1px solid var(--border); border-radius: 9px;
  font-size: 12.5px; cursor: pointer; transition: .14s;
}
.adv-toggle:hover { border-color: var(--accent); color: var(--accent); }
.adv-caret { font-size: 10px; color: var(--muted); }
.adv-title { font-weight: 600; }
.adv-meta { margin-left: auto; font-size: 11px; color: var(--muted); display: flex; gap: 7px; }
.adv-set { color: var(--accent); font-style: normal; }

.adv-body { margin-top: 10px; }
.adv-group { margin-bottom: 14px; }
.adv-group-head {
  display: flex; align-items: center; gap: 8px;
  font-size: 11.5px; color: var(--muted); font-weight: 600;
  padding-bottom: 5px; margin-bottom: 8px;
  border-bottom: 1px dashed var(--border);
}

/* 协议选择 */
.proto-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
@media (max-width: 620px) { .proto-row { grid-template-columns: 1fr; } }
.proto-btn {
  display: flex; flex-direction: column; gap: 2px;
  padding: 8px 10px; text-align: left;
  background: var(--bg); color: var(--text-2);
  border: 1.5px solid var(--border); border-radius: 9px;
  cursor: pointer; transition: .14s;
}
.proto-btn:hover:not(:disabled) { border-color: var(--accent); }
.proto-btn.active {
  border-color: var(--accent); background: var(--accent-soft); color: var(--accent);
}
.proto-btn:disabled { opacity: .4; cursor: not-allowed; }
.proto-name { font-size: 12.5px; font-weight: 600; }
.proto-desc { font-size: 10.5px; opacity: .75; }

/* 多选 chip */
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

.hint code {
  font-family: ui-monospace, Menlo, monospace;
  background: var(--code-bg); padding: 0 3px; border-radius: 3px;
}
.field { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.label {
  font-size: 12px; color: var(--text-2);
  display: flex; align-items: baseline; gap: 5px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.mono {
  font-style: normal; font-size: 10px; color: var(--muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.field input, .field select, .field textarea {
  width: 100%; padding: 5px 8px; font-size: 12.5px;
  background: var(--bg); color: var(--text);
  border: 1px solid var(--border); border-radius: 7px; outline: none;
  font-family: inherit;
}
.field textarea { resize: vertical; font-family: ui-monospace, Menlo, monospace; font-size: 12px; }
.field input:focus, .field select:focus, .field textarea:focus {
  border-color: var(--accent); box-shadow: 0 0 0 3px rgba(99,102,241,.12);
}

.hint { font-size: 11px; color: var(--muted); margin-top: 7px; line-height: 1.6; }

.raw-toggle {
  border: none; background: transparent; color: var(--text-2);
  font-size: 12px; font-weight: 600; padding: 0 0 7px; cursor: pointer;
}
.raw {
  width: 100%; padding: 9px 11px; font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: var(--code-bg); color: var(--text);
  border: 1px solid var(--border); border-radius: 8px; outline: none;
  resize: vertical;
}
.raw:focus { border-color: var(--accent); }

.dlg-foot {
  flex: 0 0 auto;
  display: flex; align-items: center; gap: 9px;
  padding: 11px 18px;
  border-top: 1px solid var(--border);
  background: var(--panel-2);
}
.spacer { flex: 1 1 auto; }
.btn {
  font-size: 13px; padding: 5px 14px; border-radius: 8px;
  border: 1px solid var(--border); background: var(--panel); color: var(--text);
  cursor: pointer;
}
.btn:hover { border-color: var(--accent); color: var(--accent); }
.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
.btn.primary:hover { filter: brightness(1.08); }

@media (max-width: 640px) {
  .grid { grid-template-columns: 1fr; }
  .mask { padding: 10px; }
}
</style>
