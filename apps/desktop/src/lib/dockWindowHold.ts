/** Occlusion/miniaturize for reconstructible dock pane bodies, not key-window
 * focus.
 *
 * Issue #37: an unfocused window can still be on screen. WebKit's Page
 * Visibility API maps to occlusion on macOS. Do not subscribe to blur.
 *
 * Independent of the terminal hold helper so this slice can merge without
 * touching that file. Terminal pane bodies stay mounted while held. */

export const DOCK_WINDOW_HOLD_DELAY_MS = 400

export type DockPaneId =
  | "collaboration"
  | "activity"
  | "changes"
  | "terminal"
  | "explorer"
  | "artifacts"

export function pageIsDockHidden(): boolean {
  return typeof document !== "undefined" && document.hidden
}

/** Reconstructible explorer/diff/artifact/activity/collaboration DOM drops
 * while the window is hidden. Terminal stays mounted so PTY ownership is
 * unchanged by this slice. */
export function dockPaneBodyMounts(id: DockPaneId, held: boolean): boolean {
  return !held || id === "terminal"
}

export function createDockWindowHold(options?: {
  delayMs?: number
  isHidden?: () => boolean
  setTimeout?: typeof setTimeout
  clearTimeout?: typeof clearTimeout
}) {
  const delayMs = options?.delayMs ?? DOCK_WINDOW_HOLD_DELAY_MS
  const isHidden = options?.isHidden ?? pageIsDockHidden
  const startTimer = options?.setTimeout ?? setTimeout
  const stopTimer = options?.clearTimeout ?? clearTimeout
  let held = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const listeners = new Set<(held: boolean) => void>()

  function notify() {
    for (const listener of listeners) listener(held)
  }

  function setHeld(next: boolean) {
    if (held === next) return
    held = next
    notify()
  }

  function sync() {
    if (!isHidden()) {
      if (timer !== undefined) {
        stopTimer(timer)
        timer = undefined
      }
      setHeld(false)
      return
    }
    if (held || timer !== undefined) return
    timer = startTimer(() => {
      timer = undefined
      if (isHidden()) setHeld(true)
    }, delayMs)
  }

  function flush() {
    if (timer !== undefined) {
      stopTimer(timer)
      timer = undefined
    }
    setHeld(isHidden())
  }

  function subscribe(listener: (held: boolean) => void) {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }

  function dispose() {
    if (timer !== undefined) stopTimer(timer)
    timer = undefined
    listeners.clear()
  }

  return { isHeld: () => held, sync, flush, subscribe, dispose }
}
