// AppKit window-state changes as one native callback (`idle_memory.rs`):
// occlusion, minimize, key, move, screen, appearance and the accessibility
// display options. Readers (`visibility.ts`, `shell/window.ts`) re-read the
// state they care about only when something changed, so an idle window runs no
// polling timer. An older addon without the callback keeps their polls.
// Off macOS the window's GPUI observers deliver instead (minimize, restore,
// activation, appearance), each with the state itself (`WindowStateReport`).
/** Off macOS: `minimized` and `visible` (Windows; null on Linux, which cannot tell) and `focused`. */
export type WindowStateReport = { minimized: boolean | null; visible: boolean | null; focused: boolean }
type StateRenderer = {
  setWindowStateCallback?: (callback: ((error: Error | null, report?: WindowStateReport | null) => void) | null) => void
  acknowledgeWindowState?: () => void
}

let installed = false
let report: WindowStateReport | null = null
const listeners = new Set<() => void>()

/** Start listening on this window's renderer; false when the addon has no window-state callback. */
export function installWindowState(renderer: object): boolean {
  const native = renderer as StateRenderer
  if (installed || typeof native.setWindowStateCallback !== 'function') return installed
  native.setWindowStateCallback((error, next) => {
    // Acknowledge first: a change while the listeners read state queues the next delivery.
    native.acknowledgeWindowState?.()
    if (error) { console.error(error); return }
    if (next && typeof next === 'object') report = next
    for (const listener of [...listeners]) listener()
  })
  installed = true
  for (const listener of [...listeners]) listener()
  return true
}

/** The last state delivered with an event off macOS; null on macOS and before the first one. */
export const windowStateReport = (): WindowStateReport | null => report

/** Whether changes arrive as events; callers poll only when this is false. */
export const hasWindowStateEvents = () => installed

/** Hear about window-state changes, and once when events become available. */
export function onWindowStateChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
