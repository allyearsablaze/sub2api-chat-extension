<template>
  <div v-if="open" class="mask" @click.self="$emit('close')">
    <div class="dialog">
      <header class="dlg-head">
        <div>
          <div class="dlg-title">设置</div>
          <div class="dlg-sub">生图工具按这里的配置注册</div>
        </div>
        <button class="x" @click="$emit('close')">✕</button>
      </header>

      <div class="dlg-body">
        <section class="block">
          <div class="block-title">生图</div>

          <label class="row">
            <span class="row-label">
              生图分组
              <em class="row-help">指定用哪个分组生图；留空则不启用生图</em>
            </span>
            <select :value="groupId ?? ''" @change="onGroupChange">
              <option value="">不使用生图</option>
              <option
                v-for="g in imageCapableGroups"
                :key="g.groupId"
                :value="g.groupId"
              >{{ g.groupName }} · {{ g.platformLabel }}</option>
            </select>
          </label>

          <div v-if="!imageCapableGroups.length" class="warn-box">
            当前没有可生图的分组。需要同时满足：平台支持生图（openai / grok / gemini / antigravity），
            且分组开启了「允许生图」。
          </div>

          <label v-if="groupId" class="row">
            <span class="row-label">
              生图模型
              <em class="row-help">{{ imageModelsLoading ? '正在拉取…' : '该分组下的生图模型' }}</em>
            </span>
            <select :value="model ?? ''" @change="$emit('update', { imageModel: $event.target.value })">
              <option value="">请选择模型</option>
              <option v-for="m in imageModels" :key="m" :value="m">{{ m }}</option>
            </select>
          </label>

          <div v-if="groupId && !imageModelsLoading && !imageModels.length" class="warn-box">
            该分组下没有识别到生图模型（名字需含 gpt-image / grok-imagine / -image）。
          </div>

          <div class="status-line">
            <span v-if="activeLabel" class="ok">✓ 生图已启用：{{ activeLabel }}</span>
            <span v-else class="off">生图未启用，generate_image 工具不会注册</span>
          </div>
        </section>

        <section class="block">
          <div class="block-title">工具超时</div>
          <p class="block-desc">
            单个工具允许执行的最长时间。<b>图片生成/编辑有独立超时</b>（180s / 240s），
            不受此值影响。
          </p>
          <label class="row">
            <span class="row-label">
              默认超时
              <em class="row-help">秒。留空按 60 秒</em>
            </span>
            <input
              type="number"
              min="5" max="600" step="5"
              :value="toolTimeoutSecs"
              placeholder="60"
              @input="$emit('update', { toolTimeoutSecs: $event.target.value === '' ? '' : Number($event.target.value) })"
            />
          </label>
          <div class="hint-line">
            web_fetch 等网络工具有自己的细粒度超时（默认 20 秒），此处只作为未声明超时的工具的兜底值。
          </div>
        </section>

        <section class="block">
          <div class="block-title">系统提示词</div>
          <p class="block-desc">
            给模型设定角色与行为规则，<b>对所有模型、所有会话生效</b>。
            留空则使用内置默认规则。
          </p>
          <textarea
            class="prompt-box"
            :value="systemPrompt"
            rows="6"
            placeholder="例如：你是一位资深的中文技术编辑。回答要简洁，先给结论，再列要点。不要使用「作为一个 AI」这类开场白。"
            @input="$emit('update', { systemPrompt: $event.target.value })"
          ></textarea>
          <div class="prompt-foot">
            <span class="prompt-count">{{ systemPrompt.length }} 字符</span>
            <button
              v-if="systemPrompt"
              class="mini-btn"
              @click="$emit('update', { systemPrompt: '' })"
            >清空</button>
          </div>
          <div class="hint-line">
            提示词会拼在系统消息最前面，内置的工具说明与运行环境信息仍会追加在后面。
          </div>
        </section>

        <section class="block">
          <div class="block-title">说明</div>
          <ul class="notes">
            <li>生图会按此处的分组与模型发起请求，与当前对话所选密钥无关。</li>
            <li>只有平台支持且分组开启「允许生图」时，才会出现在上面的下拉里。</li>
            <li>设置保存在本浏览器，换浏览器需重新配置。</li>
          </ul>
        </section>
      </div>

      <footer class="dlg-foot">
        <button class="btn" @click="$emit('reset')">重置</button>
        <span class="spacer"></span>
        <button class="btn primary" @click="$emit('close')">完成</button>
      </footer>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { pickImageModels } from '../../engine/runtime/tools/image.js'

const props = defineProps({
  open: { type: Boolean, default: false },
  channels: { type: Array, default: () => [] },     // 所有密钥（含分组信息）
  groupId: { type: [Number, null], default: null },
  model: { type: String, default: '' },
  systemPrompt: { type: String, default: '' },
  toolTimeoutSecs: { type: [Number, String], default: 60 },
})
const emit = defineEmits(['close', 'update', 'reset'])

const imageModels = ref([])
const imageModelsLoading = ref(false)

/** 可生图的分组：平台支持 + allow_image_generation */
const imageCapableGroups = computed(() => {
  const seen = new Map()
  for (const c of props.channels) {
    if (c.groupId && c.allowImageGeneration) {
      if (!seen.has(c.groupId)) {
        seen.set(c.groupId, {
          groupId: c.groupId,
          groupName: c.groupName,
          platformLabel: c.platformLabel,
          platform: c.platform,
          key: c.apiKey,
        })
      }
    }
  }
  return [...seen.values()]
})

const activeLabel = computed(() => {
  if (!props.groupId || !props.model) return ''
  const g = imageCapableGroups.value.find((x) => Number(x.groupId) === Number(props.groupId))
  return g ? `${g.groupName} / ${props.model}` : ''
})

async function loadModels() {
  const g = imageCapableGroups.value.find((x) => Number(x.groupId) === Number(props.groupId))
  if (!g) { imageModels.value = []; return }
  imageModelsLoading.value = true
  try {
    // 直接用该分组的密钥拉模型，再筛出生图模型
    const gw = g.platform === 'anthropic' || g.platform === 'typesafe' ? 'anthropic' : 'openai'
    const url = (g.platform === 'gemini' || g.platform === 'antigravity') ? '/v1beta/models' : '/v1/models'
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + g.key } })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const j = await res.json()
    let ids = []
    if (Array.isArray(j.data)) ids = j.data.map((m) => m.id || m.name).filter(Boolean)
    else if (Array.isArray(j.models)) ids = j.models.map((m) => String(m.name || '').replace(/^models\//, '')).filter(Boolean)
    imageModels.value = pickImageModels(Array.from(new Set(ids)), g.platform)
  } catch (_) {
    imageModels.value = []
  } finally {
    imageModelsLoading.value = false
  }
}

function onGroupChange(e) {
  const v = e.target.value
  emit('update', { imageGroupId: v ? Number(v) : null, imageModel: '' })
}

watch(() => [props.open, props.groupId], () => {
  if (props.open && props.groupId) loadModels()
}, { immediate: true })
</script>

<style scoped>
.mask {
  position: fixed; inset: 0; z-index: 80;
  background: rgba(0,0,0,.45);
  display: grid; place-items: center; padding: 24px;
}
.dialog {
  width: min(560px, 100%);
  max-height: min(84vh, 700px);
  display: flex; flex-direction: column;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: 0 20px 60px rgba(0,0,0,.28);
  overflow: hidden;
}
.dlg-head {
  display: flex; align-items: flex-start; justify-content: space-between;
  padding: 15px 18px 12px; border-bottom: 1px solid var(--border);
}
.dlg-title { font-size: 15px; font-weight: 600; }
.dlg-sub { font-size: 12px; color: var(--muted); margin-top: 2px; }
.x { border: none; background: transparent; color: var(--muted); font-size: 15px; padding: 2px 7px; border-radius: 6px; cursor: pointer; }
.x:hover { background: var(--bg); color: var(--text); }

.dlg-body { flex: 1; overflow-y: auto; padding: 14px 18px; }
.block { margin-bottom: 18px; }
.block-title {
  font-size: 12px; font-weight: 600; color: var(--text-2);
  padding-bottom: 6px; margin-bottom: 10px;
  border-bottom: 1px dashed var(--border);
}
.row { display: flex; flex-direction: column; gap: 5px; margin-bottom: 12px; }
.row-label { font-size: 12.5px; color: var(--text-2); display: flex; flex-direction: column; gap: 1px; }
.row-help { font-style: normal; font-size: 11px; color: var(--muted); }
.row select,
.row input {
  width: 100%; padding: 6px 9px; font-size: 13px;
  background: var(--bg); color: var(--text);
  border: 1px solid var(--border); border-radius: 8px; outline: none;
  /* 数字框统一用等宽数字，避免宽度跳动 */
  font-variant-numeric: tabular-nums;
}
.row select { cursor: pointer; }
.row select:focus,
.row input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(99,102,241,.12); }
.row input::placeholder { color: var(--muted); opacity: .75; }

/* 数字输入的步进按钮在深色主题下是浅色方块，去掉更干净 */
.row input[type='number']::-webkit-outer-spin-button,
.row input[type='number']::-webkit-inner-spin-button {
  -webkit-appearance: none; margin: 0;
}
.row input[type='number'] { -moz-appearance: textfield; appearance: textfield; }

.warn-box {
  font-size: 12px; line-height: 1.65;
  color: var(--warn); background: #fffbeb;
  border: 1px solid #fcd34d; border-radius: 8px;
  padding: 8px 11px; margin-bottom: 12px;
}
html[data-theme='dark'] .warn-box { background: #2a1c05; border-color: #78350f; }

.status-line { font-size: 12px; margin-top: 4px; }
.status-line .ok { color: var(--ok); }
.status-line .off { color: var(--muted); }

.notes { margin: 0; padding-left: 18px; font-size: 12px; color: var(--muted); line-height: 1.8; }

.block-desc { font-size: 12px; color: var(--muted); margin: 0 0 8px; line-height: 1.7; }
.block-desc b { color: var(--text-2); }

.prompt-box {
  width: 100%; resize: vertical; min-height: 110px;
  padding: 9px 11px; font-size: 12.5px; line-height: 1.7;
  background: var(--bg); color: var(--text);
  border: 1px solid var(--border); border-radius: 8px;
  outline: none; font-family: inherit;
}
.prompt-box:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(99,102,241,.12); }

.prompt-foot {
  display: flex; align-items: center; gap: 8px;
  margin-top: 5px;
}
.prompt-count { font-size: 11px; color: var(--muted); margin-right: auto; }
.mini-btn {
  font-size: 11px; padding: 1px 9px;
  background: var(--panel); color: var(--text-2);
  border: 1px solid var(--border); border-radius: 5px; cursor: pointer;
}
.mini-btn:hover { border-color: var(--accent); color: var(--accent); }

.hint-line { font-size: 11px; color: var(--muted); margin-top: 6px; line-height: 1.7; }

.dlg-foot {
  display: flex; align-items: center; gap: 9px;
  padding: 11px 18px; border-top: 1px solid var(--border); background: var(--panel-2);
}
.spacer { flex: 1 1 auto; }
.btn {
  font-size: 13px; padding: 5px 14px; border-radius: 8px;
  border: 1px solid var(--border); background: var(--panel); color: var(--text); cursor: pointer;
}
.btn:hover { border-color: var(--accent); color: var(--accent); }
.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
</style>
