/**
 * 工具注册表：所有内置工具、MCP 工具、技能工具都登记在这里，
 * 由 agent_executor 按环境/SubAgent 策略筛选后交给模型。
 */

/**
 * 只读工具白名单：SubAgent 处于 read_only 访问模式时只下发这些工具。
 * 未列入的一律视为会改变页面或扩展状态（点击、输入、脚本、标签页增删、配置写入）。
 */
export const READ_ONLY_TOOL_NAMES = new Set([
  /* 页面读取 */
  'get_page_snapshot',
  'query_elements',
  'query_by_text',
  'get_element_info',
  'get_whole_html',
  'extract_text',
  'extract_links',
  'extract_table',
  'extract_form_schema',
  'extract_meta_tags',
  'extract_jsonld',
  'extract_all_anchors',
  'extract_buttons_info',
  'assert_page_state',
  'wait_for_element',
  /* 标签页读取 */
  'list_tabs',
  'get_active_tab',
  'list_frames',
  'wait_for_navigation',
  /* 技能与工具元信息 */
  'skills_list',
  'skills_view',
  'skills_read_file',
  'tool_list',
  'subagents_list',
  'mcp_service_list',
  'mcp_tool_list',
  'get_mcp_service',
  /* 纯计算工具 */
  'jsonpath_query',
  'regex_extract',
  'jwt_decode',
  'url_decode',
  'url_encode',
  'encoding_convert',
  'hash_digest',
  'random_number',
  'random_string',
  'random_uuid',
  'random_uuid32',
  'get_storage'
])

export class ToolRegistry {
  constructor() {
    this.tools = new Map()
  }

  register(tool) {
    if (!tool?.name) throw new Error('工具必须包含 name')
    if (typeof tool.handler !== 'function') throw new Error(`工具 ${tool.name} 缺少 handler`)
    this.tools.set(tool.name, {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.parameters || { type: 'object', properties: {} },
      category: tool.category || 'general',
      risk: tool.risk || 'low',
      // default：默认对所有 Agent 可见；admin：需在 Agent 能力里显式勾选才会下发
      expose: tool.expose || 'default',
      // read：只读取页面/标签页状态；write：会改变页面或扩展数据
      readOnly: tool.readOnly === undefined ? READ_ONLY_TOOL_NAMES.has(tool.name) : !!tool.readOnly,
      /* 工具级超时：生图 180s / 编图 240s。
       * 必须在注册时保留——否则 tool_loop 里读到的永远是 undefined，
       * 实际只能退化成全局超时。 */
      timeoutMs: Number(tool.timeoutMs) > 0 ? Number(tool.timeoutMs) : 0,
      handler: tool.handler
    })
    return this
  }

  registerAll(tools = []) {
    for (const tool of tools) this.register(tool)
    return this
  }

  has(name) {
    return this.tools.has(name)
  }

  get(name) {
    return this.tools.get(name) || null
  }

  names() {
    return [...this.tools.keys()].sort()
  }

  list({ includeParameters = false, category = '' } = {}) {
    return [...this.tools.values()]
      .filter((tool) => !category || tool.category === category)
      .map((tool) =>
        includeParameters
          ? {
              name: tool.name,
              description: tool.description,
              category: tool.category,
              risk: tool.risk,
              expose: tool.expose,
              readOnly: tool.readOnly,
              parameters: tool.parameters
            }
          : {
              name: tool.name,
              description: tool.description,
              category: tool.category,
              risk: tool.risk,
              expose: tool.expose,
              readOnly: tool.readOnly
            }
      )
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /** 转成模型 function calling 需要的 schema 数组 */
  toModelTools(names) {
    const allowed = names ? new Set(names) : null
    return [...this.tools.values()]
      .filter((tool) => (allowed ? allowed.has(tool.name) : true))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }))
  }
}

export const toolRegistry = new ToolRegistry()

export function jsonSchema(properties = {}, required = []) {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false
  }
}

export const schemaTypes = {
  string: (description, extra = {}) => ({ type: 'string', description, ...extra }),
  number: (description, extra = {}) => ({ type: 'number', description, ...extra }),
  boolean: (description, extra = {}) => ({ type: 'boolean', description, ...extra }),
  array: (description, items, extra = {}) => ({ type: 'array', description, items, ...extra }),
  object: (description, extra = {}) => ({ type: 'object', description, ...extra }),
  enum: (description, values, extra = {}) => ({ type: 'string', description, enum: values, ...extra })
}

/** 轻量入参校验：只检查必填字段是否存在，让模型得到可自我纠正的错误提示 */
export function missingRequiredParams(schema, args = {}) {
  const required = Array.isArray(schema?.required) ? schema.required : []
  const payload = args && typeof args === 'object' ? args : {}
  return required.filter((key) => payload[key] === undefined || payload[key] === null || payload[key] === '')
}
