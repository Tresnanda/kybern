// Attention pop (`.t-pop`, `styles/motion.css`): one small bump for a badge or count that just changed or appeared: scale
// 0.85 -> 1 and opacity 0.4 -> 1 over `--duration-fast` (250 ms) with `--ease-bounce` (cubic-bezier(0.34, 1.36, 0.64, 1)).
//
// Patched native build (`native/patches/pop_gpui.py`): `paintAnimation: { kind: 'pop', cycleMs }` on a passive text or SVG leaf.
// The renderer re-scales and re-fades the leaf's glyph sprites about the leaf's centre at every presented frame without element
// render, layout or prepaint, and stops asking for frames once the curve has ended, so a pop costs a scene replay per frame for
// 250 ms and nothing afterwards. Paint-only, like a CSS transform: layout and hit testing do not move. It plays when the element
// mounts, so (as with the desktop's `key={count}`) a new `key` plays it again.
//
// Only leaves pop: a `Label` or an icon, not a box with a background. With the stock addon (`KYBERN_GPUIX_NATIVE=npm`) and
// under Reduce Motion (`.t-pop { animation: none }`) the element simply appears.
import { useRef } from 'react'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { REDUCED_MOTION } from '../ui.tsx'

/** `--duration-fast`. */
export const POP_MS = 250
export type PopAnimation = { kind: 'pop'; cycleMs: number; delayMs?: number }

/** The `paintAnimation` prop that pops a text or SVG leaf when it mounts (undefined when it cannot play). */
export function popAnimation(delayMs = 0): PopAnimation | undefined {
  return PATCHED_NATIVE && !REDUCED_MOTION ? { kind: 'pop', cycleMs: POP_MS, ...(delayMs ? { delayMs } : {}) } : undefined
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
