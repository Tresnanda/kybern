// The open thread composer's focus, per pane: a surface that held the keyboard (a live visual) gives it back here.
const focusers = new Map<string, () => void>()
export function setThreadComposerFocus(paneId: string, focus: () => void) { focusers.set(paneId, focus) }
export function focusThreadComposer(paneId: string) { focusers.get(paneId)?.() }
