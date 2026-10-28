/**
 * 存储结构：以 awake-claw 的 SQLite schema 为蓝本，落到 IndexedDB。
 * 每张表对应一个 objectStore，字段名保持与后端一致（snake_case），
 * 但 JSON 字段直接以对象存储，不再做序列化。
 */
export const DB_NAME = 'smartpage_agent'
export const DB_VERSION = 6

export const STORE_DEFS = {
  providers: {
    keyPath: 'id',
    autoIncrement: true,
    indexes: [{ name: 'name', keyPath: 'name' }]
  },
  models: {
    keyPath: 'id',
    autoIncrement: true,
    indexes: [
      { name: 'provider_id', keyPath: 'provider_id' },
      { name: 'alias', keyPath: 'alias' }
    ]
  },
  prompt_templates: {
    keyPath: 'id',
    autoIncrement: true,
    indexes: [{ name: 'name', keyPath: 'name' }]
  },
  /* 生成/编辑出的图片缓存。给模型只暴露短 ID，取图时按 ID 回查，
   * 避免 base64 进入上下文。单独建表是因为体积大且与事件生命周期不同。 */
  image_cache: {
    keyPath: 'id',
    autoIncrement: false,
    indexes: [
      { name: 'session_id', keyPath: 'session_id' },
      { name: 'created_at', keyPath: 'created_at' },
      { name: 'parent_id', keyPath: 'parent_id' },
      { name: 'turn_id', keyPath: 'turn_id' }
    ]
  },
  mcp_servers: {
    keyPath: 'id',
    autoIncrement: true,
    indexes: [{ name: 'name', keyPath: 'name' }]
  },
  skills: {
    keyPath: 'id',
    autoIncrement: true,
    indexes: [{ name: 'name', keyPath: 'name' }]
  },
  agents: {
    keyPath: 'id',
    autoIncrement: true,
    indexes: [{ name: 'name', keyPath: 'name' }]
  },
  environments: {
    keyPath: 'id',
    autoIncrement: true,
    indexes: [{ name: 'name', keyPath: 'name' }]
  },
  sessions: {
    keyPath: 'id',
    autoIncrement: true,
    indexes: [
      { name: 'updated_at', keyPath: 'updated_at' },
      { name: 'environment_id', keyPath: 'environment_id' }
    ]
  },
  message_events: {
    keyPath: 'id',
    autoIncrement: true,
    indexes: [
      { name: 'session_id', keyPath: 'session_id' },
      { name: 'session_turn', keyPath: ['session_id', 'turn_id'] },
      { name: 'parent_event_id', keyPath: 'parent_event_id' },
      { name: 'created_at', keyPath: 'created_at' }
    ]
  },
  config: {
    keyPath: 'key',
    autoIncrement: false,
    indexes: []
  },
  /* 会话附件：粘贴 / 拖拽 / 选择文件后上传，随消息一起发送 */
  attachments: {
    keyPath: 'id',
    autoIncrement: true,
    indexes: [{ name: 'session_id', keyPath: 'session_id' }]
  },
  /* 会话任务队列：执行中排队等待的消息 */
  message_tasks: {
    keyPath: 'id',
    autoIncrement: true,
    indexes: [
      { name: 'session_id', keyPath: 'session_id' },
      { name: 'status', keyPath: 'status' }
    ]
  },
  /*
   * 追加消息队列：追加到当前轮的内容先入队（pending），
   * 等模型循环真正取用时才落成 append_message 事件并标记 delivered。
   * 语义对齐 awake-claw 的 message_append_items 表。
   */
  message_append_items: {
    keyPath: 'id',
    autoIncrement: true,
    indexes: [
      { name: 'session_id', keyPath: 'session_id' },
      { name: 'turn_id', keyPath: 'turn_id' },
      { name: 'status', keyPath: 'status' }
    ]
  }
}

/** 全局配置默认值（设置页分组渲染依赖于 config_meta.js） */
export const DEFAULT_CONFIG = {
  /* 模型请求 */
  model_request_timeout_secs: 120,
  model_http_max_retries: 2,
  model_retry_backoff_ms: 2000,
  max_tool_rounds: 30,
  /* 工具与脚本 */
  tool_timeout_secs: 60,
  allow_script: false,
  cdp_script_fallback: true,
  script_timeout_secs: 30,
  click_settle_ms: 120,
  /* 网络抓取（web_fetch） */
  web_fetch_enabled: true,
  web_fetch_timeout_secs: 20,
  web_fetch_max_chars: 20000,
  web_fetch_allowed_domains: '',
  /* MCP */
  mcp_connect_timeout_secs: 20,
  mcp_tool_cache_minutes: 10,
  seed_version: 0
}
