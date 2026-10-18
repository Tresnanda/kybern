export type LayoutRect = { x: number; y: number; width: number; height: number }
export type WindowResizeEvent = { width: number; height: number; scaleFactor: number; frame: number }
/** Window coordinates: x, y, width, height, then top-left/right, bottom-right/left radii. */
export type RoundedLayoutClip = [number,number,number,number,number,number,number,number]
export type ElementBoundsEvent = { elementId: number | null; rect: LayoutRect | null; clippedRect: LayoutRect | null; roundedClips?: RoundedLayoutClip[] | null; scrollTop?: [number, number] | null; frame: number }
export type BoundsTarget = number | { testId: string } | { id: number }
interface LayoutRenderer {
  addLayoutObserver(target: number | { testId: string } | null, callback: (error: Error | null, value: unknown) => void): number
  removeLayoutObserver(token: number): void
  isLayoutObserverActive(token: number): boolean
}
function observe<T>(renderer: object, target: number | { testId: string } | null, callback: (event: T) => void): () => void {
  const native = renderer as LayoutRenderer
  if (typeof native.addLayoutObserver !== 'function' || typeof native.isLayoutObserverActive !== 'function') throw Error('Layout observers require the current Kybern native build')
  let live = true
  const token = native.addLayoutObserver(target, (error, event) => {
    if (!live) return
    if (error) { console.error(error); return }
    // A callback may already be in the JS queue when the native window closes.
    try { if (!native.isLayoutObserverActive(token)) return } catch { return }
    callback(event as T)
  })
  return () => {
    if (!live) return
    live = false
    // Window teardown has already discarded the native subscription.
    try { native.removeLayoutObserver(token) } catch { /* Closed window. */ }
  }
}
/** Initial size after paint, then changed sizes only. No JS timer. */
export function onWindowResize(renderer: object, callback: (event: WindowResizeEvent) => void) {
  return observe(renderer, null, callback)
}
/** Numeric refs stay attached to that host; test IDs follow replacements. */
export function observeElementBounds(renderer: object, target: BoundsTarget, callback: (event: ElementBoundsEvent) => void) {
  return observe(renderer, typeof target === 'object' && 'id' in target ? target.id : target, callback)
}
