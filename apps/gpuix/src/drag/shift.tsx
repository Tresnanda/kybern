// Siblings that make room for a dragged item. Shifts are native translations (FLIP): no sibling is
// re-laid-out while the pointer moves, only its paint offset springs. A row subscribes to its own
// number, so a pointer move re-renders just the rows whose shift changed.
import { motion } from '@gpuix/react'
import { useSyncExternalStore, type ReactNode } from 'react'
import { REDUCED_MOTION } from '../ui.tsx'
import { SPRING } from './spring.ts'

export function createShiftStore() {
  let shifts = new Map<string, number>()
  let instant = false
  const listeners = new Set<() => void>()
  const emit = () => listeners.forEach((fn) => fn())
  return {
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    get: (id: string) => shifts.get(id) ?? 0,
    /** True while shifts jump instead of spring (the commit that makes the real layout match them). */
    instant: () => instant,
    set(next: Map<string, number>) {
      let changed = next.size !== shifts.size
      if (!changed) for (const [k, v] of next) if (shifts.get(k) !== v) { changed = true; break }
      if (!changed) return
      shifts = next; instant = false; emit()
    },
    clear(snap = false) {
      if (!shifts.size) return
      shifts = new Map(); instant = snap; emit()
    },
  }
}
export type ShiftStore = ReturnType<typeof createShiftStore>

/** Wrap a row's content. At rest it is a pass-through translation of 0. */
export function ShiftRow({ store, id, axis = 'y', children }: { store: ShiftStore; id: string; axis?: 'x' | 'y'; children: ReactNode }) {
  const shift = useSyncExternalStore(store.subscribe, () => store.get(id))
  const snap = store.instant()
  return (
    <motion.div
      initial={false}
      animate={axis === 'x' ? { translateX: shift, translateY: 0 } : { translateX: 0, translateY: shift }}
      transition={REDUCED_MOTION || snap ? { duration: 0 } : SPRING.shift}
      style={axis === 'x' ? { display: 'flex', flexDirection: 'row', alignItems: 'center', height: 28, flexShrink: 0 } : { display: 'flex', flexDirection: 'column', width: '100%' }}
    >
      {children}
    </motion.div>
  )
}
