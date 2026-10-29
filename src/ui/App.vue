<template>
  <div class="app">
    <!-- 顶栏 -->
    <header class="topbar">
      <!-- 窄屏：打开会话抽屉 -->
      <button class="btn ghost only-mobile" title="会话列表" @click="railOpen = true">☰</button>
      <div class="brand">AI 对话</div>

      <label class="field">
        <span class="field-label">密钥</span>
        <select v-model="selectedKeyId" :disabled="loading || sessionBusy || !usableChannels.length" @change="onKeyChange">
          <option v-if="!usableChannels.length" :value="null">—</option>
          <option v-for="c in usableChannels" :key="c.keyId" :value="c.keyId">
            {{ c.keyName }} · {{ c.groupName }} · {{ c.platformLabel }}
          </option>
        </select>
      </label>

      <span v-if="currentChannel" class="badge" :class="badgeClass">
        {{ currentChannel.platformLabel }}
        <template v-if="rateText"> ×{{ rateText }}</template>
        <template v-if="canImage"> · 生图</template>
      </span>

      <label class="field">
        <span class="field-label">模型</span>
        <select v-model="selectedModel" :disabled="loading || sessionBusy || !chatModels.length" @change="onModelChange">
          <option v-if="!chatModels.length" :value="null">{{ modelPlaceholder }}</option>
          <option v-for="m in chatModels" :key="m" :value="m">{{ m }}</option>
        </select>
      </label>

      <!-- 生图：显示设置里配置的分组/模型；未配置则不显示 -->
      <span v-if="imageConfig" class="badge ok" :title="`生图：${imageConfig.groupName} / ${imageConfig.model}`">
        🎨 {{ imageConfig.model }}
      </span>
      <span v-else-if="imageConfigError" class="badge warn" :title="imageConfigError">
        🎨 生图未生效
      </span>

      <span class="spacer"></span>

      <button class="btn ghost" title="模型参数" @click="paramOpen = true">参数</button>
      <button class="btn ghost" title="设置" @click="settingsOpen = true">设置</button>
      <button class="btn ghost only-mobile" title="新建会话" @click="onRailCreate">＋</button>
      <button class="btn ghost" :disabled="loading || sessionBusy" @click="reload">刷新</button>
      <button class="btn ghost" :title="isDark ? '浅色' : '深色'" @click="toggleTheme">
        {{ isDark ? '☀' : '◐' }}
      </button>
    </header>

    <!-- 提示条 -->
    <div v-if="notice" class="notice" :class="notice.kind">
      <span>{{ notice.text }}</span>
      <button v-if="notice.retry" class="btn tiny" @click="notice.retry(); notice = null">重试</button>
      <button class="btn tiny ghost" @click="notice = null">关闭</button>
    </div>

    <div class="body">
      <!-- 会话栏：窄屏时变成抽屉 -->
      <div v-if="railOpen" class="rail-mask only-mobile" @click.self="railOpen = false"></div>
      <SessionRail
        class="rail-wrap"
        :class="{ open: railOpen }"
        :sessions="sessions"
        :active-id="session?.id ?? null"
        :busy="sessionBusy || runningTask !== null"
        @create="onRailCreate"
        @select="onRailSelect"
        @remove="removeSession"
        @rename="renameSession"
        @clear="clearSession"
      />

      <!-- 右侧：消息区 + 输入区（同列，宽度天然对齐） -->
      <div class="chat-col">
        <main ref="scrollBox" class="main">
          <div class="wrap">
            <EventTimeline
              v-if="turns.length"
              :turns="turns"
              @preview="preview = $event"
              @retry-turn="retryTurn"
              @delete-turn="deleteTurn"
            />

            <div v-else class="empty">
              <div class="empty-icon">💬</div>
              <h2>{{ emptyTitle }}</h2>
              <p>{{ emptyHint }}</p>
            </div>
          </div>
        </main>

        <Composer
          ref="composerRef"
          :disabled="!ready"
          :is-running="sessionBusy || runningTask !== null"
          :running-task="runningTask"
          :queued-tasks="queuedTasks"
          :image-model="activeImageModel"
          :status-text="statusText"
          :placeholder="inputPlaceholder"
          @send="onSend"
          @stop="stopRunning"
          @cancel-queued="cancelQueued"
          @edit-queued="editQueued"
        />
      </div>
    </div>

    <!-- 模型参数 -->
    <ParamDialog
      :open="paramOpen"
      :protocol="currentProtocol"
      :provider-kind="currentProviderKind"
      :model-label="selectedModel || ''"
      :model-params="modelParams"
      :runtime="runtimeParams"
      :execution="executionParams"
      @close="paramOpen = false"
      @save="onSaveParams"
      @change-protocol="onChangeProtocol"
    />

    <!-- 设置 -->
    <SettingsDialog
      :open="settingsOpen"
      :channels="channels"
      :group-id="settings.imageGroupId"
      :model="settings.imageModel"
      :system-prompt="settings.systemPrompt"
      :tool-timeout-secs="toolTimeoutSecsRef"
      @close="settingsOpen = false"
      @update="onSettingsUpdate"
      @reset="onSettingsReset"
    />

    <!-- 图片预览 -->
    <div v-if="preview" class="lightbox" @click="preview = null">
      <img :src="preview" alt="预览" />
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, nextTick, watch, shallowRef } from 'vue'
import EventTimeline from './components/EventTimeline.vue'
import SessionRail from './components/SessionRail.vue'
import Composer from './components/Composer.vue'
import ParamDialog from './components/ParamDialog.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import { loadSettings, saveSettings, clearSettings } from './settings.js'
import { loadChannels, fetchModels, readToken } from './sub2api.js'
import {
  createChatSession, runSessionTurn, resolveToolNames, switchSessionModel, ensureProviderModel,
  channelSupportsImage, pickImageModels, platformSupportsImage,
  listSessions, getSession, deleteSession, listEventVos,
  clearSessionHistory, removeTurn, updateSession, pruneOrphanProviders, toolRegistry,
  getConfigValue, setConfigValue
} from './engine.js'
import { SessionQueue } from './queue.js'
import { listProviders } from '../engine/repository/catalog.js'
import { groupTurns } from './timeline.js'

import { loadUiState, saveSelection, saveParameterDraft, loadParameterDraft, clearParameterDrafts } from './persistence.js'

// ── 基础状态 ──
const token = ref(readToken())
const channels = ref([])
const savedUi = loadUiState()
const selectedKeyId = ref(savedUi.selection?.keyId ?? null)
const models = ref([])
const chatModels = ref([])       // 对话模型（已排除生图模型）
const selectedModel = ref(savedUi.selection?.model || null)
const loading = ref(true)
const modelsLoading = ref(false)
const sessions = ref([])
const session = ref(null)
const events = ref([])
const notice = ref(null)
const preview = ref(null)
const statusText = ref('正在初始化…')
const isDark = ref(false)
const runningTask = ref(null)
/* 全局忙碌标记：从「用户点发送」那一刻置位，直到该会话这一轮结束/失败才清除。
 *
 * 为什么不用队列反推：队列要等一拍才把任务标成 running，
 * 这个窗口里用户能切走会话，正在执行的那轮就丢了。
 * 用一个显式状态覆盖整个生命周期，没有空档。 */
const sessionBusy = ref(false)
const queuedTasks = ref([])
const scrollBox = ref(null)
const composerRef = ref(null)
const railOpen = ref(false)          // 窄屏会话抽屉
const paramOpen = ref(false)
const settingsOpen = ref(false)
const settings = ref(loadSettings())
/* 工具超时存在 config 表（引擎要读），这里只做界面回显 */
const toolTimeoutSecsRef = ref(60)
const modelParams = ref({})       // 会话级模型参数（temperature 等）
const runtimeParams = ref({})     // context_window 等
const executionParams = ref({})   // max_tool_call_rounds 等

const queue = shallowRef(null)
let abortCtl = null

// ── 派生 ──
/* 每个密钥的模型分类结果：Map<keyId, { chat: string[], image: string[] }>
 * 在 reload 时并发拉取一次，供下拉过滤与生图模型选择共用。 */
const imageModelsByKey = ref(new Map())

/* 可用于对话的密钥：
 * 有些密钥只挂了生图模型（如「GPT-生图(1K)」分组），排除生图模型后没有对话模型，
 * 这种密钥不该出现在下拉里——选中它只会得到「无可用模型」。
 *
 * 注意：channels 仍保留全量，因为生图配置需要按 groupId 找到对应密钥的 apiKey。
 * 那些「只用于生图」的密钥正是生图配置要用的，不能从 channels 里删掉。 */
const usableChannels = computed(() => {
  const imgs = imageModelsByKey.value
  return channels.value.filter((c) => {
    const list = imgs.get(c.keyId)
    // 还没拉过模型（undefined）时先保留，避免启动瞬间下拉是空的
    if (!list) return true
    return list.chat.length > 0
  })
})

const currentChannel = computed(() =>
  channels.value.find((c) => c.keyId === selectedKeyId.value) || null
)

const canImage = computed(() => channelSupportsImage(currentChannel.value))
const activeImageModel = computed(() => imageConfig.value?.model || '')

/* 当前会话的 API 协议。优先级：用户手动选择 > 会话快照 > 网关默认 */
const protocolOverride = ref('')
const currentProtocol = computed(() => {
  if (protocolOverride.value) return protocolOverride.value
  const snapApi = session.value?.model_snapshot?.api
  if (snapApi) return snapApi
  const g = currentChannel.value?.gateway
  if (g === 'anthropic') return 'messages'
  return 'completions'
})
const currentProviderKind = computed(() =>
  currentChannel.value?.gateway === 'anthropic' ? 'anthropic' : 'openai-compatible'
)

/* 设置里的生图配置是否可用。
 *
 * 判定三道，与后端校验一致：
 *   1. settings 里选了分组与模型
 *   2. 能按 groupId 找到密钥（要有 apiKey 才能发请求）
 *   3. 该分组 allow_image_generation = true 且平台支持生图
 *
 * 实现要点：computed 必须**纯计算**，不能在里面写 ref。
 * 之前把错误信息写进 imageConfigError.value 是在 computed 里产生副作用，
 * 会干扰 Vue 的依赖收集，导致 channels 后来加载完了 computed 也不重算，
 * 表现为「明明配了却说找不到密钥」。
 */
const imageCheck = computed(() => {
  const gid = settings.value.imageGroupId
  const model = String(settings.value.imageModel || '').trim()

  if (!gid) return { config: null, error: '' }
  if (!model) return { config: null, error: '已选生图分组，但未选择生图模型' }

  const ch = channels.value.find((c) => Number(c.groupId) === Number(gid))
  if (!ch) return { config: null, error: `找不到分组 #${gid} 的可用密钥（可能已被删除）` }
  if (!ch.allowImageGeneration) return { config: null, error: `分组「${ch.groupName}」未开启「允许生图」` }
  if (!platformSupportsImage(ch.platform)) {
    return { config: null, error: `分组「${ch.groupName}」的平台 ${ch.platformLabel} 不支持生图` }
  }

  return {
    config: {
      groupId: gid,
      model,
      apiKey: ch.apiKey,
      platform: ch.platform,
      platformLabel: ch.platformLabel,
      groupName: ch.groupName,
    },
    error: '',
  }
})

const imageConfig = computed(() => imageCheck.value.config)
const imageConfigError = computed(() => imageCheck.value.error)

const turns = computed(() => groupTurns(events.value))
const rateText = computed(() => {
  const r = currentChannel.value?.rateMultiplier
  return !r || r === 1 ? '' : String(r)
})
const badgeClass = computed(() => (currentChannel.value?.claudeCodeOnly ? 'warn' : ''))

const ready = computed(() => !!session.value && !!selectedModel.value && !modelsLoading.value)
const modelPlaceholder = computed(() => {
  if (!currentChannel.value) return '请先选择密钥'
  if (modelsLoading.value) return '加载中…'
  return '无可用模型'
})
const emptyTitle = computed(() => {
  if (!token.value) return '未登录'
  if (!channels.value.length) return '没有可用的 API 密钥'
  if (!session.value) return '新建一个会话'
  return '开始对话'
})
const emptyHint = computed(() => {
  if (!token.value) return '未检测到登录态，请先登录主站。'
  if (!channels.value.length) return '请到主站「API 密钥」页面创建密钥后点「刷新」。'
  if (!session.value) return '点左上角「＋」新建会话。'
  return '输入消息，或直接粘贴图片。'
})
const inputPlaceholder = computed(() => {
  if (!currentChannel.value) return '请先选择密钥'
  if (!selectedModel.value) return '请先选择模型'
  if (runningTask.value) return '发送将进入排队…'
  return '输入消息…'
})

// ── 主题 ──
function applyTheme(dark) {
  isDark.value = dark
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light')
}
function toggleTheme() {
  applyTheme(!isDark.value)
  try { localStorage.setItem('s2chat_theme', isDark.value ? 'dark' : 'light') } catch (_) {}
}
function initTheme() {
  let saved = null
  try { saved = localStorage.getItem('s2chat_theme') } catch (_) {}
  try {
    const q = new URLSearchParams(location.search).get('theme')
    if (q === 'dark' || q === 'light') return applyTheme(q === 'dark')
  } catch (_) {}
  if (saved === 'dark' || saved === 'light') return applyTheme(saved === 'dark')
  applyTheme(window.matchMedia?.('(prefers-color-scheme: dark)').matches || false)
}

/** One hydration path for refresh, session switch and model/key changes. */
function applySnapshot(snap = {}) {
  protocolOverride.value = ''
  modelParams.value = JSON.parse(JSON.stringify(snap.model_params || {}))
  executionParams.value = JSON.parse(JSON.stringify(snap.execution_params || {}))
  runtimeParams.value = Object.fromEntries(
    ['context_window', 'max_history_messages', 'history_token_ratio', 'modalities']
      .filter((key) => snap[key] !== undefined && snap[key] !== null)
      .map((key) => [key, JSON.parse(JSON.stringify(snap[key]))])
  )
}
function rememberSelection() {
  saveSelection({ keyId: selectedKeyId.value, model: selectedModel.value, sessionId: session.value?.id })
}
function parameterValues() {
  return {
    api: currentProtocol.value,
    model_params: modelParams.value,
    execution_params: executionParams.value,
    ...runtimeParams.value,
  }
}
// ── 加载 ──
async function reload() {
  loading.value = true
  notice.value = null
  statusText.value = '正在加载密钥…'
  try {
    if (!token.value) {
      statusText.value = '未登录'
      notice.value = { kind: 'err', text: '未检测到登录态，请先登录主站。' }
      return
    }
    const list = await loadChannels({ token: token.value })
    channels.value = list
    await pruneOrphanProviders(list.map((c) => c.keyId)).catch(() => {})

    if (!list.length) {
      statusText.value = '没有可用密钥'
      notice.value = { kind: 'warn', text: '未找到可用 API 密钥，请到主站创建后点「刷新」。' }
      return
    }

    // 并发拉一次所有密钥的模型，用于过滤「无对话模型」的密钥
    statusText.value = '正在检查密钥可用性…'
    await loadAllKeyModels(list)

    const usable = usableChannels.value
    if (!usable.length) {
      statusText.value = '没有可用于对话的密钥'
      notice.value = {
        kind: 'warn',
        text: '所有密钥下都没有对话模型（可能只挂了生图模型）。请到主站为密钥分配对话模型分组。',
      }
      return
    }

    /* 刷新时保留当前会话：优先用内存里的，其次用上次记下的。
     * 浏览器刷新后内存是空的，没有这条兜底就会停在「无会话」状态，
     * 参数面板读到空值，看起来像「参数没持久化」。 */
    const keepSessionId = session.value?.id ?? loadUiState().selection?.sessionId ?? settings.value.lastSessionId ?? null
    const keep = usable.find((c) => String(c.keyId) === String(selectedKeyId.value))
    selectedKeyId.value = (keep || usable[0]).keyId

    if (keepSessionId) {
      await reloadChannelKeepSession(keepSessionId)
    } else {
      await onKeyChange()
    }
    await refreshSessions()
  } catch (e) {
    statusText.value = '加载失败'
    notice.value = {
      kind: 'err', text: e.message || String(e),
      retry: e.code === 401 ? null : () => reload()
    }
  } finally {
    loading.value = false
  }
}

/**
 * 刷新场景：重载密钥与模型列表，但保留当前会话与消息。
 * onKeyChange 会清空 session/events（那是「切换密钥」的正确行为），
 * 刷新不该走那条路径，否则用户正在看的对话会被清掉。
 */
async function reloadChannelKeepSession(sessionId) {
  const c = currentChannel.value
  if (!c) return
  try {
    const list = await fetchModels(c)
    models.value = list
    const imgs = pickImageModels(list, c.platform)
    chatModels.value = list.filter((m) => !imgs.includes(m))

    const savedModel = selectedModel.value
    const s = await getSession(sessionId)
    const { providerId } = await providerIdsForChannel(c)
    const validSession = s && Number(s.provider_id) === Number(providerId)
    const sessionModel = s?.model_snapshot?.model_label
    if (validSession && chatModels.value.includes(sessionModel)) {
      await selectSession(sessionId)
    } else {
      session.value = null
      events.value = []
      queue.value = null
      selectedModel.value = chatModels.value.includes(savedModel) ? savedModel : (chatModels.value[0] || null)
      applySnapshot({})
      if (validSession && selectedModel.value) {
        await switchSessionModel(c, sessionId, selectedModel.value)
        await selectSession(sessionId)
      }
      rememberSelection()
    }
    statusText.value = '已刷新'
  } catch (e) {
    notice.value = { kind: 'err', text: `刷新失败：${e.message || e}` }
  }
}

/**
 * 并发拉取所有密钥的模型列表，按「对话 / 生图」分类缓存。
 *
 * 目的：过滤掉「排除生图模型后没有对话模型」的密钥——这类密钥选中后
 * 只会显示「无可用模型」，放进下拉是干扰。
 * 单个密钥失败不影响其它密钥（失败视为空列表）。
 */
async function loadAllKeyModels(list) {
  const map = new Map()
  await Promise.all(
    list.map(async (c) => {
      try {
        const ids = await fetchModels(c)
        const imgs = pickImageModels(ids, c.platform)
        map.set(c.keyId, {
          all: ids,
          image: imgs,
          chat: ids.filter((m) => !imgs.includes(m)),
        })
      } catch (_) {
        // 拉取失败：当作没有模型，避免把坏密钥放进下拉
        map.set(c.keyId, { all: [], image: [], chat: [] })
      }
    })
  )
  imageModelsByKey.value = map
}

async function onKeyChange(event) {
  const preferredModel = event ? null : selectedModel.value
  const c = currentChannel.value
  if (!c) return
  models.value = []
  chatModels.value = []
  selectedModel.value = null
  session.value = null
  events.value = []
  queue.value = null
  applySnapshot({})
  settings.value = saveSettings({ lastSessionId: null })

  notice.value = c.claudeCodeOnly
    ? { kind: 'warn', text: `分组「${c.groupName}」限制为 Claude Code 客户端，本页请求可能被拒绝。` }
    : null

  modelsLoading.value = true
  statusText.value = '正在拉取模型…'
  try {
    // 优先用 reload 阶段已缓存的结果，避免重复请求
    const cached = imageModelsByKey.value.get(c.keyId)
    let list
    if (cached) {
      list = cached.all
    } else {
      list = await fetchModels(c)
      const imgs2 = pickImageModels(list, c.platform)
      imageModelsByKey.value = new Map(imageModelsByKey.value).set(c.keyId, {
        all: list,
        image: imgs2,
        chat: list.filter((m) => !imgs2.includes(m)),
      })
    }
    models.value = list

    const imgs = pickImageModels(list, c.platform)
    chatModels.value = list.filter((m) => !imgs.includes(m))

    if (!chatModels.value.length) {
      // 只挂了生图模型：明确告知，而不是笼统说「无可用模型」
      statusText.value = '该密钥只有生图模型'
      notice.value = {
        kind: 'warn',
        text: `密钥「${c.keyName}」下只有生图模型（${imgs.join(', ')}），没有可用于对话的模型。`,
      }
      selectedModel.value = null
      await refreshSessions()
      return
    }

    selectedModel.value = chatModels.value.includes(preferredModel) ? preferredModel : chatModels.value[0]
    if (!event) applySnapshot(loadParameterDraft(c.keyId, selectedModel.value, null) || {})
    else saveParameterDraft(c.keyId, selectedModel.value, null, parameterValues())
    rememberSelection()
    await refreshSessions()
    statusText.value = '就绪'
  } catch (e) {
    statusText.value = '拉取模型失败'
    notice.value = { kind: 'err', text: `拉取模型失败：${e.message || e}`, retry: () => onKeyChange() }
  } finally {
    modelsLoading.value = false
  }
}

async function onModelChange() {
  const c = currentChannel.value
  const m = selectedModel.value
  if (!c || !m) return
  applySnapshot({})
  if (session.value) clearParameterDrafts(session.value.id)
  // 会话已存在时，把新模型写回会话，否则请求仍会用旧模型
  if (session.value) {
    try {
      await switchSessionModel(c, session.value.id, m)
      session.value = await getSession(session.value.id)
      applySnapshot(session.value.model_snapshot)
      statusText.value = `已切换到 ${m}`
    } catch (e) {
      notice.value = { kind: 'err', text: `切换模型失败：${e.message || e}` }
    }
  }
  if (!session.value) saveParameterDraft(c.keyId, m, null, parameterValues())
  rememberSelection()
  await refreshSessions()
}

async function refreshSessions() {
  const all = await listSessions()
  const c = currentChannel.value

  /* 只显示「当前密钥」下的会话。
   * 原写法 `!pids.size || pids.has(...)` 有缺陷：新密钥还没创建过 provider 时
   * pids 为空，`!pids.size` 为真 → 所有密钥的会话都被放出来，
   * 表现为「切换密钥后仍看到上一个密钥的会话」。 */
  let visible = []
  if (c) {
    const { providerId } = await providerIdsForChannel(c)
    visible = providerId
      ? all.filter((s) => Number(s.provider_id) === Number(providerId))
      : []
  }
  sessions.value = visible.map((s) => ({ ...s, messageCount: s.message_count || 0 }))

  // 当前打开的会话若已不属于该密钥，清空视图（但不自动新建）
  if (session.value) {
    const still = sessions.value.find((s) => s.id === session.value.id)
    if (!still) {
      session.value = null
      events.value = []
      queue.value = null
    }
  }
}

// 拿当前 channel 对应的 providerId（不创建）
async function providerIdsForChannel(c) {
  const providers = await listProviders()
  const p = providers.find((x) => Number(x.provider_config?.key_id) === Number(c.keyId))
  return { providerId: p?.id ?? null }
}

// ── 会话操作 ──
async function newSession() {
  const c = currentChannel.value
  const m = selectedModel.value
  if (!c || !m) {
    notice.value = { kind: 'warn', text: '请先选择密钥和模型。' }
    return
  }
  try {
    const draft = session.value ? null : loadParameterDraft(c.keyId, m, null)
    const s = await createChatSession(c, m)
    if (draft) {
      await updateSession(s.id, { model_snapshot: { ...s.model_snapshot, ...draft } })
    }
    await refreshSessions()
    await selectSession(s.id)
    composerRef.value?.focus()
  } catch (e) {
    notice.value = { kind: 'err', text: `新建会话失败：${e.message || e}` }
  }
}

function onRailCreate() {
  railOpen.value = false
  if (guardBusy('新建会话')) return
  newSession()
}

function onRailSelect(id) {
  railOpen.value = false
  const blocked = guardBusy('切换会话')
  if (blocked) return
  selectSession(id)
}

/**
 * 生成中禁止切换会话。
 *
 * 原因：一轮执行中会持续往当前会话写事件，切走后这些事件无处可写；
 * 实测表现为「对话进行到一半，切回来发现整轮消失了」。
 * 与其让用户丢数据，不如直接拦住并给出明确提示。
 */
function guardBusy(action) {
  if (!sessionBusy.value && !runningTask.value) return false
  notice.value = {
    kind: 'warn',
    text: `正在生成回复，暂时不能${action}。请等待完成或先点「停止」。`,
  }
  statusText.value = '生成中，暂不可切换'
  setTimeout(() => {
    if (notice.value?.kind === 'warn' && /正在生成回复/.test(notice.value.text)) {
      notice.value = null
    }
  }, 4000)
  return true
}

async function selectSession(id) {
  if (queue.value) queue.value.stop()
  const s = await getSession(id)
  if (!s) return
  session.value = s
  events.value = await listEventVos(id)
  const snap = s.model_snapshot || {}
  if (snap.model_label) selectedModel.value = snap.model_label
  applySnapshot(snap)
  rememberSelection()

  // 重建队列
  queue.value = new SessionQueue({
    sessionId: id,
    runner: executeTask,
    onChange: () => refreshQueueView(),
    // 队列空转 = 真的没有在跑的任务了，解除忙碌
    onIdle: () => { sessionBusy.value = false },
  })
  /* 忙碌状态按新会话的真实情况重置：
   * 切到的会话如果自己还有未完成任务，仍应视为忙碌。 */
  const pending = (await queue.value.list().catch(() => []))
    .filter((t) => t.status === 'queued' || t.status === 'running')
  sessionBusy.value = pending.length > 0
  await refreshQueueView()
  // 记住当前会话，刷新后自动恢复（否则参数面板读不到已保存的值）
  settings.value = saveSettings({ lastSessionId: id })
  statusText.value = events.value.length ? '已恢复历史' : '就绪'
  await scrollToBottom(true)
}

async function refreshQueueView() {
  if (!queue.value) { runningTask.value = null; queuedTasks.value = []; return }
  const list = await queue.value.list()
  runningTask.value = list.find((t) => t.status === 'running') || null
  queuedTasks.value = list.filter((t) => t.status !== 'running')
  /* 队列刚 push、还没进入 running 的窗口期也要算忙碌，
   * 否则用户可以在这个间隙切走，导致正在执行的轮次丢失。 */
  if (!runningTask.value && queue.value.busyHint && queuedTasks.value.length) {
    runningTask.value = queuedTasks.value[0]
  }
}

async function removeSession(s) {
  if (guardBusy('删除会话')) return
  if (!confirm(`删除会话「${s.title}」及其全部消息？`)) return
  await deleteSession(s.id)
  clearParameterDrafts(s.id)
  if (session.value?.id === s.id) {
    session.value = null
    events.value = []
    queue.value = null
    sessionBusy.value = false
    settings.value = saveSettings({ lastSessionId: null })
    rememberSelection()
    if (preview.value) preview.value = null
  }
  await refreshSessions()
  statusText.value = '已删除会话'
}

/**
 * 清空会话消息，但保留会话本身与它的设置（模型、参数、协议）。
 * 同时清空该会话的图片缓存——消息没了，图也没人引用了。
 */
async function clearSession(s) {
  if (guardBusy('清空会话')) return
  const title = s.title || '该会话'
  if (!confirm(`清空「${title}」的全部消息与图片缓存？会话本身与模型设置会保留。`)) return
  try {
    const removed = await clearSessionHistory(s.id)
    // 若清空的正是当前会话，刷新视图
    if (session.value?.id === s.id) {
      events.value = []
      if (preview.value) preview.value = null
    }
    await refreshSessions()
    statusText.value = removed ? `已清空 ${removed} 条消息` : '会话已是空的'
  } catch (e) {
    notice.value = { kind: 'err', text: `清空失败：${e.message || e}` }
  }
}

async function renameSession({ session: s, title }) {
  await updateSession(s.id, { title })
  if (session.value?.id === s.id) session.value = { ...session.value, title }
  await refreshSessions()
}

// ── 模型参数 ──
async function onSaveParams({ modelParams: mp, runtime, execution }) {
  const c = currentChannel.value
  const m = selectedModel.value
  if (!c || !m) return
  modelParams.value = mp || {}
  runtimeParams.value = runtime || {}
  executionParams.value = execution || {}
  // Capture identity + values before any await; never save into another session after switching.
  const sid = session.value?.id ?? null
  const values = JSON.parse(JSON.stringify(parameterValues()))
  try {
    saveParameterDraft(c.keyId, m, sid, values)
    rememberSelection()
    if (sid !== null) {
      const { providerId, modelId } = await ensureProviderModel(c, m)
      const snap = {
        ...(session.value?.id === sid ? session.value.model_snapshot : {}),
        provider_id: providerId, model_id: modelId,
        provider_kind: currentProviderKind.value,
        provider_label: `${c.keyName} · ${c.groupName}`, model_label: m,
        ...values,
      }
      const saved = await updateSession(sid, { provider_id: providerId, model_id: modelId, model_snapshot: snap })
      if (session.value?.id === sid) { session.value = saved; applySnapshot(saved.model_snapshot) }
    }
    statusText.value = '参数已保存'
  } catch (e) {
    notice.value = { kind: 'err', text: `保存参数失败：${e.message || e}` }
  }
}

/** 切换 API 协议：字段集随之变化，必须写回会话的 api 与快照 */
async function onChangeProtocol(protocol) {
  protocolOverride.value = protocol
  const c = currentChannel.value
  if (!c || !session.value) return
  try {
    /* 切换协议只清模型参数（旧协议的字段在新协议里多半非法），
     * 但运行参数（上下文窗口 / 模态）与协议无关，必须保留。
     * 这里直接取面板当前值，避免「改完还没保存就切协议」导致丢失。 */
    const prevSnap = session.value.model_snapshot || {}
    const snap = {
      ...prevSnap,
      api: protocol,
      model_params: {},
      context_window: runtimeParams.value?.context_window || prevSnap.context_window,
      max_history_messages: runtimeParams.value?.max_history_messages ?? prevSnap.max_history_messages,
      history_token_ratio: runtimeParams.value?.history_token_ratio ?? prevSnap.history_token_ratio,
      modalities: runtimeParams.value?.modalities?.length
        ? runtimeParams.value.modalities
        : prevSnap.modalities,
    }
    await updateSession(session.value.id, { api: protocol, model_snapshot: snap })
    session.value = await getSession(session.value.id)
    modelParams.value = {}
    statusText.value = `协议已切换为 ${protocol}`
  } catch (e) {
    notice.value = { kind: 'err', text: `切换协议失败：${e.message || e}` }
  }
}

// ── 设置 ──
async function onSettingsUpdate(patch) {
  // 图片配置与提示词是纯前端设置
  const { toolTimeoutSecs, ...rest } = patch
  if (Object.keys(rest).length) settings.value = saveSettings(rest)

  /* 工具超时要写进 config 表：引擎层（agent_executor）从那里读取。
   * 只放 localStorage 的话后端执行时读不到。 */
  if (toolTimeoutSecs !== undefined) {
    const secs = Number(toolTimeoutSecs)
    const value = Number.isFinite(secs) && secs > 0 ? secs : 60
    try {
      await setConfigValue('tool_timeout_secs', value)
      toolTimeoutSecsRef.value = value
      statusText.value = '工具超时已保存'
    } catch (e) {
      notice.value = { kind: 'err', text: `保存超时失败：${e.message || e}` }
    }
  }
}

function onSettingsReset() {
  settings.value = clearSettings()
}

// ── 发送（入队）──
async function onSend(payload) {
  if (payload?.__error) {
    notice.value = { kind: 'err', text: payload.__error }
    return
  }
  if (!session.value || !queue.value) {
    notice.value = { kind: 'warn', text: '请先新建会话。' }
    return
  }
  // 先置忙碌再入队：入队到真正开跑之间也有间隔，不能留空档
  sessionBusy.value = true
  try {
    await queue.value.push({
      content: payload.content,
      attachmentIds: [],       // 附件以 data_url 内联，无需单独存储
      attachments: payload.attachments,
    })
    await refreshQueueView()
  } catch (e) {
    sessionBusy.value = false
    notice.value = { kind: 'err', text: e.message || String(e) }
  }
}

/** 队列真正执行一条任务 */
async function executeTask(task, signal) {
  const c = currentChannel.value
  if (!c) throw new Error('密钥不可用')
  const modelName = selectedModel.value
  /* 输入模态决定是否注册 read_image。
   * 优先用 runtimeParams（用户刚在面板里改的值），再退回会话快照。
   * 反过来会导致刚勾选图片、但快照还没同步时工具不注册。 */
  const modalities = (runtimeParams.value?.modalities?.length
    ? runtimeParams.value.modalities
    : session.value?.model_snapshot?.modalities) || ['text']
  const toolNames = resolveToolNames(c, {
    imageConfig: imageConfig.value,
    modalities,
  })

  runningTask.value = task
  statusText.value = '生成中…'
  abortCtl = signal

  try {
    await runSessionTurn({
      sessionId: session.value.id,
      input: {
        text: task.content,
        attachments: task.attachments || [],
      },
      // 全局系统提示词：设置里配置，所有模型共享
      persona: String(settings.value.systemPrompt || '').trim(),
      signal,
      toolNames,
      toolContext: {
        apiKey: c.apiKey,
        platform: c.platform,
        platformLabel: c.platformLabel,
        baseUrl: '',
        model: modelName,
        // 生图使用设置里指定的分组与模型（与当前对话密钥无关）
        imageConfig: imageConfig.value,
        // 缓存图片时记录归属会话，便于按会话清理
        sessionId: session.value?.id ?? null,
      },
      emit: (evt) => {
        if (evt?.type === 'event' && evt.event) upsertEvent(evt.event)
        else if (evt?.type === 'notice') statusText.value = evt.text || statusText.value
      },
    })
    statusText.value = '完成'
  } catch (e) {
    const msg = e?.message || String(e)
    if (e?.name === 'AbortError' || /CANCELLED|已停止/.test(msg)) {
      statusText.value = '已停止'
    } else {
      statusText.value = '出错'
      notice.value = { kind: 'err', text: msg }
    }
  } finally {
    runningTask.value = null
    abortCtl = null
    /* 这里不清 sessionBusy：此时队列里那条任务还是 running。
     * 交给 queue 的 onIdle 回调——队列彻底空转时才代表真的空了。 */
    await scrollToBottom()
  }
}

function stopRunning() {
  if (!queue.value) return
  queue.value.stop()
  /* 立即解除忙碌：abort 到 finally 之间还有一小段，
   * 用户点了停止就该能马上切会话。 */
  sessionBusy.value = false
  runningTask.value = null
  statusText.value = '正在停止…'
}

async function cancelQueued(t) {
  if (!queue.value) return
  await queue.value.cancel(t.id)
  await refreshQueueView()
  if (!runningTask.value && !queuedTasks.value.length) sessionBusy.value = false
}

async function editQueued({ task, content }) {
  if (!queue.value) return
  await queue.value.edit(task.id, { content })
  await refreshQueueView()
}

// ── 事件合并 ──
function upsertEvent(incoming) {
  const list = events.value
  const idx = list.findIndex((e) => e.id === incoming.id)
  if (idx === -1) list.push(incoming)
  else if ((incoming.revision ?? 1) >= (list[idx].revision ?? 1)) list[idx] = incoming
  events.value = [...list]
  scrollToBottom()
}

async function retryTurn(turnId) {
  if (!session.value) return
  const lastUser = [...events.value].reverse().find(
    (e) => e.turn_id === turnId && (e.event_type === 'user_message' || e.event_type === 'append_message')
  )
  if (!lastUser) return
  const text = typeof lastUser.content === 'string' ? lastUser.content : lastUser.content?.text
  if (!text) return
  await removeTurn(session.value.id, turnId).catch(() => {})
  events.value = await listEventVos(session.value.id)
  await onSend({ content: text, attachments: [] })
}

/** 删除单轮。引擎层会连带清理该轮产生的图片缓存。 */
async function deleteTurn(turnId) {
  if (!session.value) return
  await removeTurn(session.value.id, turnId).catch(() => {})
  events.value = await listEventVos(session.value.id)
  if (preview.value) preview.value = null
  await refreshSessions()
  statusText.value = '已删除本轮'
}

// ── 滚动 ──
async function scrollToBottom(force = false) {
  await nextTick()
  const box = scrollBox.value
  if (!box) return
  const near = box.scrollHeight - box.scrollTop - box.clientHeight < 160
  if (force || near) box.scrollTop = box.scrollHeight
}
watch(() => events.value.length, () => scrollToBottom())

onMounted(async () => {
  initTheme()
  // 工具超时存在 config 表，进页面时读一次
  try {
    const secs = await getConfigValue('tool_timeout_secs', 60)
    toolTimeoutSecsRef.value = Number(secs) > 0 ? Number(secs) : 60
  } catch (_) { /* 读不到就用默认 */ }
  await reload()
  // 诊断：便于排查「配了生图却不生效」这类现场问题
  if (typeof window !== 'undefined') {
    window.__s2diag = () => ({
      settings: settings.value,
      channels: channels.value.map((c) => ({
        keyId: c.keyId, groupId: c.groupId, groupName: c.groupName,
        platform: c.platform, allow: c.allowImageGeneration,
        hasKey: !!c.apiKey,
      })),
      imageCheck: imageCheck.value,
      currentKeyId: selectedKeyId.value,
      runtimeParams: runtimeParams.value,
      modalitiesInUse: (runtimeParams.value?.modalities?.length
        ? runtimeParams.value.modalities
        : session.value?.model_snapshot?.modalities) || ['text'],
      toolNames: resolveToolNames(currentChannel.value || {}, {
        imageConfig: imageConfig.value,
        modalities: (runtimeParams.value?.modalities?.length
          ? runtimeParams.value.modalities
          : session.value?.model_snapshot?.modalities) || ['text'],
      }),
    })
  }
})
</script>

<style scoped>
.app { height: 100%; display: flex; flex-direction: column; overflow: hidden; }

.topbar {
  flex: 0 0 auto; display: flex; align-items: center; gap: 9px;
  padding: 8px 13px; background: var(--panel);
  border-bottom: 1px solid var(--border); flex-wrap: wrap;
}
.brand { font-weight: 600; font-size: 14px; }
.spacer { flex: 1 1 auto; }
.field { display: flex; align-items: center; gap: 5px; }
.field-label { font-size: 12px; color: var(--muted); white-space: nowrap; }
.field select {
  max-width: 215px; padding: 5px 8px;
  background: var(--panel); color: var(--text);
  border: 1px solid var(--border); border-radius: 8px;
  cursor: pointer; outline: none; font-size: 13px;
}
.field select:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(99,102,241,.15); }
.field select:disabled { opacity: .55; cursor: not-allowed; }

.badge {
  font-size: 11px; padding: 2px 8px; border-radius: 999px;
  background: var(--bg); border: 1px solid var(--border);
  color: var(--muted); white-space: nowrap;
}
.badge.warn { color: var(--warn); border-color: var(--warn); }

.btn {
  font-size: 13px; padding: 5px 12px; border-radius: 8px;
  border: 1px solid var(--border); background: var(--panel); color: var(--text);
  cursor: pointer; transition: .15s;
}
.btn:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.btn:disabled { opacity: .5; cursor: not-allowed; }
.btn.ghost { border-color: transparent; background: transparent; color: var(--muted); }
.btn.ghost:hover:not(:disabled) { background: var(--bg); color: var(--text); }
.btn.tiny { font-size: 12px; padding: 1px 8px; }

.notice {
  flex: 0 0 auto; display: flex; align-items: center; gap: 10px;
  padding: 8px 14px; font-size: 13px; border-bottom: 1px solid var(--border);
}
.notice.warn { background: #fffbeb; color: #92400e; border-color: #fcd34d; }
.notice.err { background: #fef2f2; color: var(--err); border-color: #fecaca; }
html[data-theme='dark'] .notice.warn { background: #2a1c05; color: #fbbf24; border-color: #78350f; }
html[data-theme='dark'] .notice.err { background: #2a0e0e; color: #f87171; border-color: #7f1d1d; }
.notice span { flex: 1; min-width: 0; }

.body { flex: 1 1 auto; display: flex; overflow: hidden; min-height: 0; }
.chat-col {
  flex: 1 1 auto; min-width: 0;
  display: flex; flex-direction: column; overflow: hidden;
}
.main { flex: 1 1 auto; overflow-y: auto; padding: 14px 16px 8px; min-width: 0; }
/* 消息与输入区共用同一宽度，左右边缘严格对齐 */
/* 内容满宽：不加 max-width，否则宽屏下两侧会留出大片空白，
 * 与输入框（满宽）对不齐，看起来像「边距又回来了」。 */
.wrap { width: 100%; }

.empty {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  text-align: center; padding: 60px 20px; color: var(--muted);
}
.empty-icon { font-size: 34px; margin-bottom: 12px; opacity: .55; }
.empty h2 { font-size: 16px; color: var(--text); margin: 0 0 7px; font-weight: 600; }
.empty p { margin: 0; font-size: 13px; max-width: 420px; line-height: 1.7; }

.lightbox {
  position: fixed; inset: 0; z-index: 99;
  background: rgba(0,0,0,.88);
  display: grid; place-items: center; padding: 24px; cursor: zoom-out;
}
.lightbox img { max-width: 100%; max-height: 100%; border-radius: 8px; }

/* 宽屏隐藏仅移动端元素 */
.only-mobile { display: none; }

@media (max-width: 760px) {
  .field-label { display: none; }
  .brand { display: none; }
  .only-mobile { display: inline-flex; }
  .main { padding: 10px 10px 4px; }

  /* 顶栏收紧，避免每项占满整行 */
  .topbar { gap: 6px; padding: 7px 10px; }
  .topbar select { max-width: 132px; font-size: 12px; padding: 4px 6px; }
  .topbar .btn { padding: 4px 8px; font-size: 12px; }

  /* 会话栏变抽屉。
   * 子组件 SessionRail 的 .rail 声明了 position: relative，
   * 用 !important 才能压过去（否则 fixed 失效、抽屉被挤到顶栏下方）。 */
  .rail-wrap {
    position: fixed !important;
    top: 0 !important;
    left: 0 !important;
    bottom: 0 !important;
    height: 100vh;
    height: 100dvh;
    width: 264px !important;
    flex: none !important;
    z-index: 60;
    border-right: none !important;
    transform: translateX(-100%);
    transition: transform .22s ease;
    box-shadow: 4px 0 24px rgba(15,23,42,.18);
    pointer-events: none;   /* 收起时不吃点击，避免挡住下层按钮 */
  }
  .rail-wrap.open {
    transform: translateX(0) !important;
    pointer-events: auto !important;
  }

  /* 遮罩只覆盖抽屉右侧，避免与抽屉重叠 */
  .rail-mask {
    position: fixed; top: 0; right: 0; bottom: 0; left: 264px;
    z-index: 55;
    background: rgba(15,23,42,.42);
    display: block;
  }
}
</style>
