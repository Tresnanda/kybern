import type { NativeRenderer } from '@gpuix/react'

type Point = { x: number; y: number }

/** Carry coordinates are native motion input, separate from React's drag lifecycle. */
export function createCarryStore() {
  let point: Point = { x: 0, y: 0 }
  const listeners = new Set<() => void>()
  return {
    get: () => point,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    set(x: number, y: number) {
      if (point.x === x && point.y === y) return
      point = { x, y }
      listeners.forEach(listener => listener())
    },
  }
}
export type CarryStore = ReturnType<typeof createCarryStore>
/** Translate the retained scene without a React commit or a native tree invalidation.
 * React owns this node's lifetime and static style; this binding alone owns its motion.
 * It adds no scheduler or work while the pointer rests. */
export function bindNativeCarry(renderer: NativeRenderer, id: number, origin: Point, store: CarryStore) {
  let last: Point | undefined
  const update = () => {
    const point = store.get()
    if (last?.x === point.x && last?.y === point.y) return
    last = point
    renderer.setSubtreeTranslation?.(id, { translateX: point.x - origin.x, translateY: point.y - origin.y })
  }
  const stop = store.subscribe(update)
  update()
  return stop
}
