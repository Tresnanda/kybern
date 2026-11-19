// GPUIX's `focusElement` reveals the element's virtual-list row by scrolling that row to the top of the list
// (`reveal_virtual_list_ancestor` in the gpuix fork), even when the element is already on screen. A Select or menu that
// hands focus back to its trigger, or a dialog returning focus to its opener, therefore moved Settings by up to a whole
// section. A list registered here keeps its logical anchor through a programmatic focus move: the anchor is read before
// the move and requested again right after it. Both requests go to the same per-list queue before the next draw, so the
// later one wins and nothing paints in between. `Transcript.tsx` does the same for its own list (`restoreFocus`).

type ListNative = {
  getListScrollTop?: (id: number) => number[] | null
  scrollToItem?: (id: number, index: number, offsetInItem?: number) => void
}

const steady = new Set<number>()
const installed = new WeakSet<object>()

/** Keep this list where it is when focus moves into it programmatically. Returns the release. */
export function holdListInPlace(listId: number): () => void {
  steady.add(listId)
  return () => { steady.delete(listId) }
}

/** Wraps `renderer.focusElement` once (`main.tsx`), after the web-view hand-back so both apply. */
export function installSteadyFocus(renderer: object) {
  if (installed.has(renderer)) return
  installed.add(renderer)
  const target = renderer as Record<string, unknown> & ListNative
  const focus = target.focusElement
  if (typeof focus !== 'function') return
  target.focusElement = function (this: unknown, ...args: unknown[]) {
    if (!steady.size) return focus.apply(this, args)
    const anchors: [number, number[]][] = []
    for (const id of steady) {
      const top = target.getListScrollTop?.(id)
      if (top && top.length >= 2) anchors.push([id, top])
    }
    const result = focus.apply(this, args)
    for (const [id, top] of anchors) target.scrollToItem?.(id, top[0]!, top[1]!)
    return result
  }
}
