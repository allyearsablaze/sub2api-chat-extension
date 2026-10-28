/**
 * 系统提示组装（Web 版）。
 *
 * 相对 SmartPageAgent 原版：原版提示词围绕「操作真实浏览器标签页」展开
 * （get_page_snapshot / switch_tab / execute_script 等）。本版运行在独立网页里，
 * 没有标签页与 DOM 注入能力，因此提示词改为「通用对话助手 + 有限工具」。
 */

const CORE_RULES = [
  '你是一个运行在网页里的 AI 助手。你通过 function calling 使用工具，工具之外的能力通过文字回答。',
  '',
  '## 工具使用原则',
  '- 只在确实需要时调用工具。能在思考中直接回答的问题，不要为了调用而调用。',
  '- 调用工具前先确认参数完整；参数不足时先向用户提问，不要凭空猜测 URL 或内容。',
  '- 同一操作失败两次就换策略，不要重复完全相同的调用。',
  '- 工具返回失败时，把失败原因如实告知用户，不要假装成功。',
  '',
  '## web_fetch',
  '- 用于读取 http/https 网页正文，返回 Markdown（默认）、纯文本或原始 HTML。',
  '- 受浏览器同源策略限制：只有目标站点允许跨域（返回 CORS 响应头）才能抓取。',
  '- 若返回 CORS 或网络错误，说明该站点不允许浏览器直连，请告知用户而不是反复重试。',
  '- 需要登录、需要 JS 渲染、或位于内网/本地地址的页面无法抓取。',
  '',
  '## generate_image',
  '- 根据文字描述生成图片，会产生费用，只在用户明确要求画图时调用。',
  '- prompt 要具体：主体、风格、构图、光线、色调等，越具体效果越好。',
  '- 工具返回的图片会直接展示给用户，不需要再用文字重复描述图片内容。',
  '',
  '## 回答风格',
  '- 使用与用户相同的语言作答。',
  '- 可以输出 Markdown（标题、列表、表格、代码块）。',
  '- 简洁优先，不要复述用户的问题，也不要在结尾堆砌客套话。'
]

const TOOL_HINTS = {
  web_fetch: '读取网页正文',
  generate_image: '生成图片',
  regex_extract: '正则提取',
  jsonpath_query: 'JSON 路径查询',
  hash_digest: '计算哈希',
  jwt_decode: '解析 JWT',
  url_encode: 'URL 编码',
  url_decode: 'URL 解码',
  encoding_convert: '编码转换',
  random_uuid: '生成 UUID',
  random_string: '生成随机字符串',
  random_number: '生成随机数'
}

/**
 * 构造主会话的系统提示。
 *
 * @param {object} options
 * @param {string} [options.persona]          自定义人格/角色设定
 * @param {string[]} [options.toolNames]      实际下发的工具名，用于生成能力清单
 * @param {string} [options.modelLabel]       当前模型展示名
 * @param {string} [options.platformLabel]    当前平台展示名
 * @param {string} [options.workspaceNote]    额外说明（例如部署路径）
 */
export function buildSessionPreamble(options = {}) {
  const {
    persona = '',
    toolNames = [],
    modelLabel = '',
    platformLabel = '',
    workspaceNote = ''
  } = options

  const sections = []

  if (String(persona || '').trim()) {
    sections.push(String(persona).trim())
  }

  sections.push(CORE_RULES.join('\n'))

  // 能力清单：只列出真正注册过的工具，避免模型试探不存在的工具
  const usable = toolNames.filter((name) => TOOL_HINTS[name])
  if (usable.length) {
    const lines = usable.map((name) => `- ${name}：${TOOL_HINTS[name]}`)
    sections.push('## 当前可用工具\n' + lines.join('\n'))
  } else {
    sections.push('## 当前可用工具\n本轮没有可用工具，请直接用文字回答。')
  }

  const envLines = []
  if (modelLabel) envLines.push(`- 模型：${modelLabel}`)
  if (platformLabel) envLines.push(`- 平台：${platformLabel}`)
  if (workspaceNote) envLines.push(`- ${workspaceNote}`)
  if (envLines.length) {
    sections.push('## 运行环境\n' + envLines.join('\n'))
  }

  return sections.join('\n\n')
}

/** 兼容原版调用点：本版没有技能体系，恒返回空串 */
export function buildSkillsSection() {
  return ''
}

export default { buildSessionPreamble, buildSkillsSection }
