/**
 * 工具可见性策略（Web 版）。
 *
 * 原版有「环境 / Agent / SubAgent」三层收窄，本版只有一层：
 * 宿主按当前密钥的平台能力注入候选工具名，这里再做一次注册表校验。
 *
 * expose='admin' 的工具（加解密、RSA 等）默认不下发，
 * 需要用户在页面的「高级工具」里显式开启。
 */
import { toolRegistry } from './registry.js'

export function visibleToolNames({ candidateNames = [], enabled = [], includeAdmin = false } = {}) {
  const pool = candidateNames.length
    ? candidateNames.filter((name) => toolRegistry.has(name))
    : toolRegistry.list().map((tool) => tool.name)

  const enabledSet = new Set(enabled.map(String))

  return pool.filter((name) => {
    const tool = toolRegistry.get(name)
    if (!tool) return false
    if (tool.expose === 'admin') return includeAdmin && enabledSet.has(name)
    return true
  })
}

export function readOnlyToolNames(names) {
  return names.filter((name) => toolRegistry.get(name)?.readOnly)
}

export function isReadOnlyTool(name) {
  return !!toolRegistry.get(name)?.readOnly
}
