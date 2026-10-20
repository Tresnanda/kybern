// Composer motion on top of `src/motion/kit.tsx`: the desktop's swaps render
// their first paint without motion (`IconSwap` / `TextSwap` in
// `components/kybern/motion.tsx`), attachment tiles `t-pop` in once, and
// removed tiles and queued rows keep their last frame for a short exit.
import { motion, type StyleDesc } from '@gpuix/react'
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import { popTransform } from '../kit/Pop.tsx'
import { DISTANCE, DURATION, EASE } from '../motion/kit.tsx'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { isWindowVisible } from '../native/visibility.ts'
import { REDUCED_MOTION } from '../ui.tsx'

// `IconSwap` / `TextSwap` for a state that flips after mount: the first state paints still, every later change (including the first)
// cross-swaps with the outgoing state kept for its exit. Pass `kind="icon"` for glyphs.
export { SwapOnChange } from '../motion/kit.tsx'

/**
 * `t-pop` (`motion.css`): an added attachment tile scales 0.85 -> 1 and fades in from 40% over `--duration-fast` on
 * `--ease-bounce`, as a whole box (`kit/Pop.tsx` `popTransform`, paint-only). Reduce Motion shows it at once.
 */
export function Pop({ children, style }: { children: ReactNode; style?: StyleDesc }) {
  return (
    <div paintTransform={popTransform()} style={{ display: 'flex', position: 'relative', flexShrink: 0, ...style }}>
      {children}
    </div>
  )
}

/**
 * A dimmed control (`opacity` 150 ms `--ease-out`, paint-only) instead of an instant opacity change: the model picker's rows while
 * a change is in flight. Reduce Motion changes at once; the stock addon keeps the plain style.
 */
export function Dim({ dimmed, level = 0.6, children, style }: { dimmed: boolean; level?: number; children: ReactNode; style?: StyleDesc }) {
  return (
    <div
      paintTransform={PATCHED_NATIVE ? { initial: false, animate: { opacity: dimmed ? level : 1 }, transition: { duration: REDUCED_MOTION ? 0 : DURATION.quick, ease: [...EASE.out] } } : undefined}
      style={{ display: 'flex', flexDirection: 'column', ...style, ...(PATCHED_NATIVE ? {} : { opacity: dimmed ? level : 1 }) }}
    >
      {children}
    </div>
  )
}

// ---- items that leave a list ----

export interface Entry<T> {
  item: T
  /** Gone from the list; kept for its exit until `gone(id)`. */
  leaving: boolean
  /** Added after the list first rendered: only these play an entrance. */
  fresh: boolean
}

/**
 * The entries of a list that keeps a removed item mounted for its exit. `items` must be referentially stable between renders (a
 * store array or state, not a fresh `.map`). An item leaves with an exit when `leaves(id)` says so (pointer removal; send/clear
 * disappear at once) and when the window is visible and the addon is patched (native frames do not run otherwise, so completion
 * would never arrive). The owner calls `gone(id)` (or `gone()` for every leaving entry) when the exit has played. Items that were
 * there at the first render are not `fresh`: initial loads do not animate.
 */
export function useLeavingList<T extends { id: string }>(items: readonly T[], leaves: (id: string) => boolean = () => true) {
  const [entries, setEntries] = useState<Entry<T>[]>(() => items.map(item => ({ item, leaving: false, fresh: false })))
  const seen = useRef(items)
  let list = entries
  if (seen.current !== items) {
    seen.current = items
    const canLeave = PATCHED_NATIVE && isWindowVisible()
    const next: Entry<T>[] = []
    for (const entry of entries) {
      const live = items.find(item => item.id === entry.item.id)
      if (live) next.push(live === entry.item && !entry.leaving ? entry : { item: live, leaving: false, fresh: entry.fresh })
      else if (entry.leaving || (canLeave && leaves(entry.item.id))) next.push(entry.leaving ? entry : { ...entry, leaving: true })
    }
    for (const item of items) if (!entries.some(entry => entry.item.id === item.id)) next.push({ item, leaving: false, fresh: true })
    if (next.length !== entries.length || next.some((entry, i) => entry !== entries[i])) {
      list = next
      setEntries(next)
    }
  }
  const gone = useCallback((id?: string) => setEntries(current => current.filter(entry => !(entry.leaving && (id === undefined || entry.item.id === id)))), [])
  return [list, gone] as const
}

let leaveGeneration = 5_000_000

/**
 * `.sa-side-row[data-leaving]`: a removed row rises 4 px, fades and collapses over 200 ms `--ease-out`, then `onDone` unmounts it.
 * The height is a layout tween (closing the gap needs one: the frame-rate lane owns that cost); the fade and lift are paint-only.
 * Reduce Motion: a 120 ms fade, no collapse.
 */
export function Leave({ height, onDone, children }: { height: number; onDone: () => void; children: ReactNode }) {
  const generation = useMemo(() => ++leaveGeneration, [])
  const ease = [...EASE.out] as [number, number, number, number]
  if (REDUCED_MOTION)
    return (
      <div
        paintTransform={{ initial: { opacity: 1 }, animate: { opacity: 0 }, transition: { duration: 0.12, ease }, generation }}
        onMotionComplete={event => { if (event.motionGeneration === generation) onDone() }}
        style={{ display: 'flex', flexDirection: 'column', pointerEvents: 'none' }}
      >
        {children}
      </div>
    )
  return (
    <motion.div
      initial={{ height }}
      animate={{ height: 0 }}
      transition={{ duration: 0.2, ease }}
      onMotionComplete={onDone}
      style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', flexShrink: 0, pointerEvents: 'none' }}
    >
      <div
        paintTransform={{ initial: { opacity: 1, translateY: 0 }, animate: { opacity: 0, translateY: -DISTANCE.micro }, transition: { duration: 0.2, ease } }}
        style={{ display: 'flex', flexDirection: 'column', flexShrink: 0 }}
      >
        {children}
      </div>
    </motion.div>
  )
}
