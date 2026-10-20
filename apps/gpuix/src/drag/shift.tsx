// Siblings that make room for a dragged item. Shifts are native translations (FLIP): no sibling is
// re-laid-out while the pointer moves, only its paint offset springs. A row subscribes to its own
// number, so a pointer move re-renders just the rows whose shift changed.
import { type MotionTransition } from '@gpuix/react'
import { PaintTranslate } from './PaintTranslate.tsx'
import { useSyncExternalStore, type ReactNode } from 'react'
import { REDUCED_MOTION } from '../ui.tsx'
import { SPRING } from './spring.ts'

export function createShiftStore() {
  let shifts = new Map<string, number>()
  let xs = new Map<string, number>()
  let instant = false
  let snapped = new Set<string>()
  const listeners = new Set<() => void>()
  const emit = () => listeners.forEach((fn) => fn())
  return {
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    get: (id: string) => shifts.get(id) ?? 0,
    /** Horizontal offset, for rows that also change column (the board). */
    getX: (id: string) => xs.get(id) ?? 0,
    /** True while shifts jump instead of spring (the commit that makes the real layout match them), or for the rows `set` asked to jump. */
    instant: (id?: string) => instant || (id !== undefined && snapped.has(id)),
    set(next: Map<string, number>, nextX: Map<string, number> = new Map(), snap: Iterable<string> = []) {
      const differs = (a: Map<string, number>, b: Map<string, number>) => {
        if (a.size !== b.size) return true
        for (const [k, v] of a) if (b.get(k) !== v) return true
        return false
      }
      if (!differs(next, shifts) && !differs(nextX, xs)) return
      shifts = next; xs = nextX; instant = false; snapped = new Set(snap); emit()
    },
    clear(snap = false) {
      if (!shifts.size && !xs.size) return
      shifts = new Map(); xs = new Map(); instant = snap; snapped = new Set(); emit()
    },
  }
}
export type ShiftStore = ReturnType<typeof createShiftStore>

/** Wrap a row's content. At rest it is a pass-through translation of 0. */
export function ShiftRow({ store, id, axis = 'y', transition = SPRING.shift, children }: { store: ShiftStore; id: string; axis?: 'x' | 'y' | 'xy'; transition?: MotionTransition; children: ReactNode }) {
  const shift = useSyncExternalStore(store.subscribe, () => store.get(id))
  const shiftX = useSyncExternalStore(store.subscribe, () => store.getX(id))
  const snap = store.instant(id)
  return (
    <PaintTranslate
      initial={false}
      animate={axis === 'x' ? { translateX: shift, translateY: 0 } : axis === 'xy' ? { translateX: shiftX, translateY: shift } : { translateX: 0, translateY: shift }}
      transition={REDUCED_MOTION || snap ? { duration: 0 } : transition}
      style={axis === 'x' ? { display: 'flex', flexDirection: 'row', alignItems: 'center', height: 28, flexShrink: 0 } : { display: 'flex', flexDirection: 'column', width: '100%' }}
    >
      {children}
    </PaintTranslate>
  )
}
