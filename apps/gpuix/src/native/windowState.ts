// AppKit window-state changes as one native callback (`idle_memory.rs`):
// occlusion, minimize, key, move, screen, appearance and the accessibility
// display options. Readers (`visibility.ts`, `shell/window.ts`) re-read the
// state they care about only when something changed, so an idle window runs no
// polling timer. An older addon without the callback keeps their polls.
type StateRenderer = {
  setWindowStateCallback?: (callback: ((error: Error | null) => void) | null) => void
  acknowledgeWindowState?: () => void
}

let installed = false
const listeners = new Set<() => void>()

/** Start listening on this window's renderer; false when the addon has no window-state callback. */
export function installWindowState(renderer: object): boolean {
  const native = renderer as StateRenderer
  if (installed || typeof native.setWindowStateCallback !== 'function') return installed
  native.setWindowStateCallback((error) => {
    // Acknowledge first: a change while the listeners read state queues the next delivery.
    native.acknowledgeWindowState?.()
    if (error) { console.error(error); return }
    for (const listener of [...listeners]) listener()
  })
  installed = true
  for (const listener of [...listeners]) listener()
  return true
}

/** Whether changes arrive as events; callers poll only when this is false. */
export const hasWindowStateEvents = () => installed

/** Hear about window-state changes, and once when events become available. */
export function onWindowStateChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
