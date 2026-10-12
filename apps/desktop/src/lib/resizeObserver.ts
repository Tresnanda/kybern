export interface ResizeFrameOptions {
  /**
   * Runs inside the observer callback: after layout, before this frame paints. Use it only for
   * cheap corrections that must not wait a frame (scroll compensation), never for work that
   * changes the observed elements' size. `onResize` still runs next frame.
   */
  immediate?: (entries: ResizeObserverEntry[]) => void
}

/** Deliver resize work next frame so layout writes cannot re-enter observer delivery. */
export function observeResizeFrame(element: Element, onResize: (entries: ResizeObserverEntry[]) => void, options?: ResizeFrameOptions): () => void {
  let frame: number | null = null
  let latest: ResizeObserverEntry[] = []
  let active = true
  const observer = new ResizeObserver((entries) => {
    if (!active) return
    options?.immediate?.(entries)
    latest = entries
    if (frame !== null) return
    frame = requestAnimationFrame(() => {
      frame = null
      if (active) onResize(latest)
    })
  })
  observer.observe(element)
  return () => {
    active = false
    observer.disconnect()
    if (frame !== null) cancelAnimationFrame(frame)
  }
}
