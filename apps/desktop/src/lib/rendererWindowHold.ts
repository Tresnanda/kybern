/** Occlusion/miniaturize for reconstructible renderer runtimes, not
 * key-window focus.
 *
 * Issue #37: an unfocused window can still be on screen. WebKit's Page
 * Visibility API maps to occlusion on macOS. Do not subscribe to blur.
 *
 * The mermaid iframe is a 1024×768 nested document. Highlight and Markdown
 * workers keep Shiki/parser heaps. All three remount lazily on the next job.
 * Independent of transcript compact and xterm WebGL dispose. */

export const RENDERER_WINDOW_HOLD_DELAY_MS = 400

export function pageIsRendererHidden(): boolean {
  return typeof document !== "undefined" && document.hidden
}

export function createRendererWindowHold(options?: {
  delayMs?: number
  isHidden?: () => boolean
  setTimeout?: typeof setTimeout
  clearTimeout?: typeof clearTimeout
  onHold?: () => void
}) {
  const delayMs = options?.delayMs ?? RENDERER_WINDOW_HOLD_DELAY_MS
  const isHidden = options?.isHidden ?? pageIsRendererHidden
  const startTimer = options?.setTimeout ?? setTimeout
  const stopTimer = options?.clearTimeout ?? clearTimeout
  const onHold = options?.onHold
  let held = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const listeners = new Set<(held: boolean) => void>()

  function notify() {
    for (const listener of listeners) listener(held)
  }

  function setHeld(next: boolean) {
    if (held === next) return
    held = next
    if (held) onHold?.()
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

/** Drop mermaid's nested document and syntax/markdown worker heaps. Lazy on next job. */
export function releaseHiddenWindowRenderers() {
  void Promise.all([
    import("./highlight").then((module) => module.releaseHighlightRuntime()),
    import("./markdown").then((module) => module.releaseMarkdownRuntime()),
    import("./mermaid").then((module) => module.releaseMermaidRenderer()),
  ]).catch(() => { /* Workers and diagram frames are browser-only. */ })
}

export function installRendererWindowHold(delayMs = RENDERER_WINDOW_HOLD_DELAY_MS) {
  if (typeof document === "undefined") return () => {}
  const hold = createRendererWindowHold({ delayMs, onHold: releaseHiddenWindowRenderers })
  const onVisibility = () => hold.sync()
  document.addEventListener("visibilitychange", onVisibility)
  hold.sync()
  return () => {
    document.removeEventListener("visibilitychange", onVisibility)
    hold.dispose()
  }
}
