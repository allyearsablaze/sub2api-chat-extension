/**
 * 工具注册入口（Web 版）。
 *
 * 相对 SmartPageAgent 原版的改动：
 *   - 移除全部依赖 chrome.* 的工具：page / page_actions / tab / tab_tools /
 *     script / tab_tools —— 纯静态页面没有标签页与脚本注入权限。
 *   - 移除 http_request：与 web_fetch 功能重叠，且同受 CORS 约束。
 *   - 移除 skills / agent_tools / subagent_tools：本版不提供技能库与 SubAgent。
 *   - 新增 generate_image：由宿主按当前密钥的平台能力动态注册。
 */
import { toolRegistry } from './registry.js'
import { registerWebTools } from './web.js'
import { registerUtilTools } from './util.js'

let registered = false

export function registerBuiltinTools() {
  if (registered) return toolRegistry
  registerWebTools()
  registerUtilTools()
  registered = true
  return toolRegistry
}

registerBuiltinTools()

export { toolRegistry }
