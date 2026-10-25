// Attention pop (`.t-pop`, `styles/motion.css`): one small bump for a badge or count that just changed or appeared: scale
// 0.85 -> 1 and opacity 0.4 -> 1 over `--duration-fast` (250 ms) with `--ease-bounce` (cubic-bezier(0.34, 1.36, 0.64, 1)).
//
// Patched native build (`the fork commit from pop_gpui.py`): `paintAnimation: { kind: 'pop', cycleMs }` on a passive text or SVG leaf.
// The renderer re-scales and re-fades the leaf's glyph sprites about the leaf's centre at every presented frame without element
// render, layout or prepaint, and stops asking for frames once the curve has ended, so a pop costs a scene replay per frame for
// 250 ms and nothing afterwards. Paint-only, like a CSS transform: layout and hit testing do not move. It plays when the element
// mounts, so (as with the desktop's `key={count}`) a new `key` plays it again.
//
// A box with a background or border (a chip, an attachment tile) pops as a whole with `popTransform()`: the paint-only
// subtree transform (`native/upstream/packages/native/src/subtree_transform.rs`) scales and fades everything the box paints about its centre,
// again with no render or layout per frame. With the stock addon (`KYBERN_GPUIX_NATIVE=npm`) and under Reduce Motion
// (`.t-pop { animation: none }`) the element simply appears.
import type { PaintTransformProps } from '@gpuix/native/host'
import { useRef } from 'react'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { EASE } from '../motion/tokens.ts'
import { REDUCED_MOTION } from '../ui.tsx'

/** `--duration-fast`. */
export const POP_MS = 250
export type PopAnimation = { kind: 'pop'; cycleMs: number; delayMs?: number }

/** The `paintAnimation` prop that pops a text or SVG leaf when it mounts (undefined when it cannot play). */
export function popAnimation(delayMs = 0): PopAnimation | undefined {
  return PATCHED_NATIVE && !REDUCED_MOTION ? { kind: 'pop', cycleMs: POP_MS, ...(delayMs ? { delayMs } : {}) } : undefined
}

/** `--ease-bounce`. */
export const EASE_BOUNCE: [number, number, number, number] = [...EASE.bounce]

/** The `paintTransform` prop that pops a whole box when it mounts (undefined when it cannot play). */
export function popTransform(delayMs = 0): PaintTransformProps | undefined {
  if (!PATCHED_NATIVE || REDUCED_MOTION) return undefined
  return { initial: { scale: 0.85, opacity: 0.4 }, animate: { scale: 1, opacity: 1 }, transition: { duration: POP_MS / 1000, delay: delayMs / 1000, ease: EASE_BOUNCE } }
}

/**
 * True once `active` has turned on after this component first rendered (a status that changes, a count that appears), false when
 * it was already on at the first render. Rows recycled by a virtual list therefore do not pop again on every scroll-in, the way
 * the desktop's DOM rows do not.
 */
export function usePopOnChange(active: boolean): boolean {
  const first = useRef(active)
  if (!active) first.current = false
  return active && !first.current
}

/**
 * A React `key` for a count, badge or number that bumps when its value changes (`t-pop` + `key={count}`): constant on the first
 * render and while `value` stays the same, a new key each time `value` changes after that. Rows recycled by a virtual list start
 * from their own first value, so scrolling in does not pop. Put it on the element that pops:
 * `<Label key={useCountPop(n)} paintAnimation={popAnimation()}>{n}</Label>`; `popAnimation()` only plays on a mount, and a changed
 * key is a new mount. Reduce Motion and the stock addon: `popAnimation()` is `undefined`, so the key change is invisible.
 */
export function useCountPop(value: string | number): number {
  const seen = useRef(value)
  const pops = useRef(0)
  if (seen.current !== value) {
    seen.current = value
    pops.current++
  }
  return pops.current
}
