// The open thread composer's focus, per pane: a surface that held the keyboard (a live visual) gives it back here.
const focusers = new Map<string, () => void>()
export function setThreadComposerFocus(paneId: string, focus: () => void) { focusers.set(paneId, focus) }
export function focusThreadComposer(paneId: string) { focusers.get(paneId)?.() }

// The open thread composer's model picker opener, per thread: failed-turn actions open it directly.
const modelPickers = new Map<string, () => void>()
export function registerThreadModelPicker(threadId: string, open: () => void): () => void {
  modelPickers.set(threadId, open)
  return () => { if (modelPickers.get(threadId) === open) modelPickers.delete(threadId) }
}
export function openThreadModelPicker(threadId: string): boolean {
  const open = modelPickers.get(threadId)
  if (!open) return false
  open()
  return true
}
