// Native scroll events do not identify whether a virtualizer or accessibility
// action moved the viewport. Remember the actual position after our own writes
// (including browser clamping), so an upward layout correction is not treated
// as reader input. Weak keys do not retain unmounted panes.
const programmaticPositions = new WeakMap<HTMLElement, number>()

export function recordScrollPosition(element: HTMLElement | null) {
  if (element) programmaticPositions.set(element, element.scrollTop)
}

export function matchesScrollPosition(element: HTMLElement, top: number): boolean {
  const written = programmaticPositions.get(element)
  return written !== undefined && Math.abs(written - top) < 1
}
