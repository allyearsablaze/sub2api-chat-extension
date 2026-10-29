/** UI preferences and per-session/model parameter drafts. Never store API keys or images. */
export const UI_STATE_KEY = 's2chat_ui_state_v1'
function read() {
  try { return JSON.parse(localStorage.getItem(UI_STATE_KEY) || '{}') || {} } catch (_) { return {} }
}
function write(value) {
  localStorage.setItem(UI_STATE_KEY, JSON.stringify(value))
  return value
}
export function loadUiState() { return read() }
export function saveSelection({ keyId, model, sessionId }) {
  return write({ ...read(), selection: { keyId: keyId ?? null, model: model || '', sessionId: sessionId ?? null } })
}
const scope = (keyId, model, sessionId) => JSON.stringify([String(keyId), model, sessionId ?? 'draft'])
export function saveParameterDraft(keyId, model, sessionId, values) {
  const state = read()
  const drafts = { ...(state.drafts || {}) }
  drafts[scope(keyId, model, sessionId)] = JSON.parse(JSON.stringify(values))
  return write({ ...state, drafts })
}
export function loadParameterDraft(keyId, model, sessionId) {
  return read().drafts?.[scope(keyId, model, sessionId)] || null
}
export function clearParameterDrafts(sessionId) {
  const state = read()
  const drafts = { ...(state.drafts || {}) }
  for (const key of Object.keys(drafts)) {
    try { if (JSON.parse(key)[2] === sessionId) delete drafts[key] } catch (_) { delete drafts[key] }
  }
  return write({ ...state, drafts })
}
