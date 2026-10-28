export function nowIso() {
  return new Date().toISOString()
}

export function nowMs() {
  return Date.now()
}

export function formatTime(value) {
  if (!value) return ''
  const date = typeof value === 'number' ? new Date(value) : new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** 生成 turn id：t-<时间戳36进制>-<随机> */
export function createTurnId() {
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
