/** Occlusion/miniaturize for reconstructible composer stacked panels, not
 * key-window focus.
 *
 * Issue #37: an unfocused window can still be on screen. WebKit's Page
 * Visibility API maps to occlusion on macOS. Do not subscribe to blur.
 *
 * The composer input stays mounted so drafts and attachment previews are
 * not discarded. Queued prompts, approvals, and questions remount from the
 * store.
 *
 * Independent of the terminal, dock, sidebar, and environment hold helpers. */

export const COMPOSER_WINDOW_HOLD_DELAY_MS = 400

export function pageIsComposerHidden(): boolean {
  return typeof document !== "undefined" && document.hidden
}

/** Stacked `above` panels remount from store. The input surface stays. */
export function composerStackedMounts(held: boolean): boolean {
  return !held
}

export function createComposerWindowHold(options?: {
  delayMs?: number
  isHidden?: () => boolean
  setTimeout?: typeof setTimeout
  clearTimeout?: typeof clearTimeout
}) {
  const delayMs = options?.delayMs ?? COMPOSER_WINDOW_HOLD_DELAY_MS
  const isHidden = options?.isHidden ?? pageIsComposerHidden
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
