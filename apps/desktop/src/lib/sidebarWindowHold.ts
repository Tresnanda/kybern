/** Occlusion/miniaturize for reconstructible sidebar lists, not key-window
 * focus.
 *
 * Issue #37: an unfocused window can still be on screen. WebKit's Page
 * Visibility API maps to occlusion on macOS. Do not subscribe to blur.
 *
 * Independent of the terminal and dock hold helpers so this slice can merge
 * without touching those files. */

export const SIDEBAR_WINDOW_HOLD_DELAY_MS = 400

export function pageIsSidebarHidden(): boolean {
  return typeof document !== "undefined" && document.hidden
}

/** Project/thread rows remount from the store. The drag-region header stays. */
export function sidebarListMounts(held: boolean): boolean {
  return !held
}

export function createSidebarWindowHold(options?: {
  delayMs?: number
  isHidden?: () => boolean
  setTimeout?: typeof setTimeout
  clearTimeout?: typeof clearTimeout
}) {
  const delayMs = options?.delayMs ?? SIDEBAR_WINDOW_HOLD_DELAY_MS
  const isHidden = options?.isHidden ?? pageIsSidebarHidden
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
