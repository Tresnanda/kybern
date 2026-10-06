// Motion for opening a subagent and coming back. A pointer navigation pushes the page in
// from the side it came from (a level deeper enters from the trailing edge, going up from
// the leading edge). Keyboard navigation (⌘[, ⌘], ⌘↑, Enter on a row) swaps instantly: it is
// repeated many times a day and motion would only slow it. With reduced motion the push is
// a short cross-fade. The animation is WAAPI so a second navigation mid-flight starts from
// the page's current on-screen opacity and offset instead of queueing or jumping.

let lastKeyAt = 0
let lastPointerAt = 0

if (typeof window !== "undefined") {
  const key = () => { lastKeyAt = performance.now() }
  const pointer = () => { lastPointerAt = performance.now() }
  window.addEventListener("keydown", key, true)
  // The mouse's back and forward buttons arrive as `mouseup`; a click starts with `pointerdown`.
  for (const type of ["pointerdown", "mousedown", "mouseup"]) window.addEventListener(type, pointer, true)
}

/** Whether the most recent input was the pointer. True before any input. */
export function lastInputWasPointer(): boolean {
  return lastPointerAt >= lastKeyAt
}

export type PageDirection = "forward" | "back"

export const PAGE_PUSH_MS = 220
export const PAGE_PUSH_DISTANCE_PX = 16
export const PAGE_FADE_MS = 120
const PAGE_EASE = "cubic-bezier(0.23, 1, 0.32, 1)"

const running = new WeakMap<HTMLElement, Animation>()

/** Offset and opacity the page shows right now, to continue from when a push is interrupted. */
function currentState(element: HTMLElement): { x: number; opacity: number } {
  const style = getComputedStyle(element)
  const matrix = style.transform && style.transform !== "none" ? new DOMMatrix(style.transform) : null
  return { x: matrix?.m41 ?? 0, opacity: Number(style.opacity) || 0 }
}

/** Bring a page in. Returns the animation so a caller can cancel it. */
export function playPageMotion(element: HTMLElement, direction: PageDirection): Animation | null {
  if (typeof element.animate !== "function") return null
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches
  const previous = running.get(element)
  const from = previous ? currentState(element) : { x: direction === "forward" ? PAGE_PUSH_DISTANCE_PX : -PAGE_PUSH_DISTANCE_PX, opacity: 0 }
  previous?.cancel()
  const animation = element.animate(
    reduced
      ? [{ opacity: from.opacity }, { opacity: 1 }]
      : [{ opacity: from.opacity, transform: `translateX(${from.x}px)` }, { opacity: 1, transform: "translateX(0)" }],
    { duration: reduced ? PAGE_FADE_MS : PAGE_PUSH_MS, easing: reduced ? "ease-out" : PAGE_EASE },
  )
  running.set(element, animation)
  const done = () => {
    if (running.get(element) === animation) running.delete(element)
  }
  animation.addEventListener("finish", done)
  animation.addEventListener("cancel", done)
  return animation
}

/**
 * Whether a move between two pages should be animated, and which way. Only moves between
 * a thread and its subagents (or two levels of subagents) animate; a move between two
 * ordinary threads does not. `depth` is 0 for an ordinary thread.
 */
export function pageDirection(from: number, to: number): PageDirection | null {
  if (from === 0 && to === 0) return null
  if (from === to) return null
  return to > from ? "forward" : "back"
}
