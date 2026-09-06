// One observer for all looping indicators; no scroll handlers or frame loop.
const visible = new Map<HTMLElement, boolean>()
let observer: IntersectionObserver | undefined

function update(element: HTMLElement, intersects: boolean) {
  element.toggleAttribute("data-loop-paused", document.hidden || !intersects)
}

function onVisibilityChange() {
  for (const [element, intersects] of visible) update(element, intersects)
}

/** Pause clipped/offscreen indicators and hidden windows without resetting their phase. */
export function observeLoopVisibility(element: HTMLElement): () => void {
  if (!observer) {
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const target = entry.target as HTMLElement
        if (!visible.has(target)) continue
        // Edge-adjacent entries can be intersecting with no visible area.
        const intersects = entry.isIntersecting && entry.intersectionRatio > 0
        visible.set(target, intersects)
        update(target, intersects)
      }
    })
    document.addEventListener("visibilitychange", onVisibilityChange)
  }

  visible.set(element, false)
  update(element, false)
  observer.observe(element)

  return () => {
    observer?.unobserve(element)
    visible.delete(element)
    element.removeAttribute("data-loop-paused")
    if (visible.size === 0) {
      observer?.disconnect()
      observer = undefined
      document.removeEventListener("visibilitychange", onVisibilityChange)
    }
  }
}
