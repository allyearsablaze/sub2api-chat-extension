/**
 * 统一错误类型。业务层抛 AppError，API 层统一转换为 { ok:false, error }。
 */
export class AppError extends Error {
  constructor(message, code = 'APP_ERROR', detail = null) {
    super(String(message || '未知错误'))
    this.name = 'AppError'
    this.code = code
    this.detail = detail
  }
}

export function fail(message, code = 'APP_ERROR', detail = null) {
  throw new AppError(message, code, detail)
}

export function ensure(condition, message, code = 'APP_ERROR') {
  if (!condition) fail(message, code)
}

export function toErrorMessage(error) {
  if (!error) return '未知错误'
  if (typeof error === 'string') return error
  return error.message || String(error)
}

export function isAbortError(error) {
  if (!error) return false
  if (error.name === 'AbortError') return true
  const message = toErrorMessage(error).toLowerCase()
  return message.includes('aborted') || message.includes('已停止') || message.includes('cancelled')
}
