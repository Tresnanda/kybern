/** Deliver resize work next frame so layout writes cannot re-enter observer delivery. */
export function observeResizeFrame(element: Element, onResize: (entries: ResizeObserverEntry[]) => void): () => void {
  let frame: number | null = null
  let latest: ResizeObserverEntry[] = []
  let active = true
  const observer = new ResizeObserver((entries) => {
    if (!active) return
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
