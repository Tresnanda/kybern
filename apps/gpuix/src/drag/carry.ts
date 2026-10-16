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
let generation = Number.MAX_SAFE_INTEGER

/** Reuse the existing native motion protocol, including its layout-neutral translations.
 * React owns this node's lifetime and static style; this binding alone owns its motion.
 * It adds no scheduler or work while the pointer rests. */
export function bindNativeCarry(renderer: NativeRenderer, id: number, origin: Point, store: CarryStore) {
  let last: Point | undefined
  const update = () => {
    const point = store.get()
    if (last?.x === point.x && last?.y === point.y) return
    last = point
    renderer.applyBatch(JSON.stringify([['setCustomProp', id, 'motion', {
      // Reserve high safe integers separately from React's small incrementing ids.
      generation: --generation,
      initial: false,
      animate: { translateX: point.x - origin.x, translateY: point.y - origin.y },
      transition: { duration: 0 },
    }]]))
  }
  const stop = store.subscribe(update)
  update()
  return stop
}
