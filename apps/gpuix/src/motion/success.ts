// Success check (`.t-success`, `styles/motion.css`): the icon fades in, rotates from -20° and bobs up while it resolves
// from a 2px blur: `--duration-very-slow` (500 ms) on `--ease-smooth-out`, keyframes 0% (opacity 0, rotate(-20deg)
// scale(0.8) translateY(2px), blur 2px), 60% (rotate(4deg) scale(1.06) translateY(-1px)), 100% (rest). Painted natively
// with no render or layout per frame (`paintTransform` keyframes, `native/patches/subtree_transform.rs`); the glyph
// rotates exactly. Reduce Motion (`.t-success { animation: none }`) shows it at rest.
//
// The check's paths also draw themselves in (`.t-success path`: `stroke-dasharray: 32`, `stroke-dashoffset: 32 -> 0` by
// `t-check-draw` over `--duration-fast` on `--ease-smooth-out` after `--duration-quick`): `paintAnimation: { kind: 'stroke' }`
// on the `<svg>` (`native/patches/stroke_draw.rs`) points the glyph's sprite at the SVG rasterized at each frame's dash
// offset, again with no render or layout per frame. `kit/Checkbox.tsx` uses the same for `.t-check-path`.
import type { PaintTransformProps } from '@gpuix/native/host'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { REDUCED_MOTION } from '../ui.tsx'
import { DURATION, EASE } from './tokens.ts'

export function successTransform(): PaintTransformProps | undefined {
  if (!PATCHED_NATIVE || REDUCED_MOTION) return undefined
  return {
    initial: { opacity: 0, rotate: -20, scale: 0.8, translateY: 2, blur: 2 },
    animate: { opacity: 1, rotate: 0, scale: 1, translateY: 0, blur: 0 },
    keyframes: [{ offset: 0.6, rotate: 4, scale: 1.06, translateY: -1 }],
    transition: { duration: DURATION.verySlow, ease: [...EASE.smoothOut] },
  }
}

export type StrokeAnimation = { kind: 'stroke'; cycleMs: number; delayMs: number; dash: number; ease: [number, number, number, number] }

/** `t-check-draw` on an `<svg>`'s paths: `stroke-dasharray: dash`, offset `dash` -> 0 over `--duration-fast` (smooth-out) after `delayMs`. */
export function strokeDraw(dash: number, delayMs: number, timing: { cycleMs?: number; ease?: readonly [number, number, number, number] } = {}): StrokeAnimation | undefined {
  if (!PATCHED_NATIVE || REDUCED_MOTION) return undefined
  return { kind: 'stroke', cycleMs: timing.cycleMs ?? DURATION.fast * 1000, delayMs, dash, ease: [...(timing.ease ?? EASE.smoothOut)] }
}

/** `.t-success path`: dasharray 32, drawn after `--duration-quick`. */
export function successStroke(): StrokeAnimation | undefined {
  return strokeDraw(32, DURATION.quick * 1000)
}

/**
 * `.rail-usage-arc` (`stroke-dashoffset` 400 ms `--ease-out`): a ring's arc draws itself in from empty when its `<svg>` mounts or its
 * `key` changes, over `--duration-slow`. `dash` is the arc's dash length in the SVG's user units (the circumference for a full ring).
 * Spread on the `<svg source>`: `<svg paintAnimation={arcDraw(dash)} key={drawKey} />`. Value-to-value tweening (old → new) needs
 * native N2, so callers re-key only when the value moves by 5 points or more (`arcKey`), and a small refresh does not redraw.
 * `undefined` under Reduce Motion (the arc shows at its value) or with the stock addon.
 */
export function arcDraw(dash: number): StrokeAnimation | undefined {
  return strokeDraw(dash, 0, { cycleMs: DURATION.slow * 1000, ease: EASE.out })
}

/** The `key` for an arc whose value is `percent` (0..100): constant within a 5-point step, so only a real move redraws it. */
export function arcKey(percent: number): number {
  return Math.round(percent / 5)
}
