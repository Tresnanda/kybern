/** Occlusion/miniaturize for reconstructible environment-card bodies, not
 * key-window focus.
 *
 * Issue #37: an unfocused window can still be on screen. WebKit's Page
 * Visibility API maps to occlusion on macOS. Do not subscribe to blur.
 * Thread.tsx already hides this card when unfocused; the body stays mounted
 * at opacity 0 until this hold fires.
 *
 * Independent of the terminal, dock, and sidebar hold helpers so this slice
 * can merge without touching those files. */

export const ENVIRONMENT_WINDOW_HOLD_DELAY_MS = 400

export function pageIsEnvironmentHidden(): boolean {
  return typeof document !== "undefined" && document.hidden
}

/** Git/diff/notes rows remount from the store and localStorage drafts. */
export function environmentPanelBodyMounts(held: boolean): boolean {
  return !held
}

export function createEnvironmentWindowHold(options?: {
  delayMs?: number
  isHidden?: () => boolean
  setTimeout?: typeof setTimeout
  clearTimeout?: typeof clearTimeout
}) {
  const delayMs = options?.delayMs ?? ENVIRONMENT_WINDOW_HOLD_DELAY_MS
  const isHidden = options?.isHidden ?? pageIsEnvironmentHidden
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
