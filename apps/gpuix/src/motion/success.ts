// Success check (`.t-success`, `styles/motion.css`): the icon fades in, rotates from -20° and bobs up while it resolves
// from a 2px blur: `--duration-very-slow` (500 ms) on `--ease-smooth-out`, keyframes 0% (opacity 0, rotate(-20deg)
// scale(0.8) translateY(2px), blur 2px), 60% (rotate(4deg) scale(1.06) translateY(-1px)), 100% (rest). Painted natively
// with no render or layout per frame (`paintTransform` keyframes, `native/upstream/packages/native/src/subtree_transform.rs`); the glyph
// rotates exactly. Reduce Motion (`.t-success { animation: none }`) shows it at rest.
//
// The check's paths also draw themselves in (`.t-success path`: `stroke-dasharray: 32`, `stroke-dashoffset: 32 -> 0` by
// `t-check-draw` over `--duration-fast` on `--ease-smooth-out` after `--duration-quick`): `paintAnimation: { kind: 'stroke' }`
// on the `<svg>` (`native/upstream/packages/native/src/stroke_draw.rs`) points the glyph's sprite at the SVG rasterized at each frame's dash
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

export type StrokeAnimation = { kind: 'stroke'; cycleMs: number; delayMs: number; dash: number; ease: [number, number, number, number]; from?: number; to?: number; retarget?: boolean }

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
 * `dash` must be the length of the arc's own path (see `ringArc`): the native draw sets `stroke-dasharray: dash`, so a dashed full
 * circle (`dasharray="length circumference"`) would repeat its dash. Spread on the `<svg source>` (the prop is not in `SvgProps`, as in `SuccessCheck`): `<svg key={drawKey} source={arc.source} {...(draw ? { paintAnimation: draw } : {})} />` with `const draw = arcDraw(arc.length)`. Value-to-value tweening (old → new) needs
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

/**
 * A ring's arc as its own SVG path, so `arcDraw(length)` draws exactly it: from 12 o'clock clockwise, `fraction` (0..1) of a circle
 * of `radius` centred in a `size` box, round-capped. Returns the SVG `source` (black, tinted by `style.color`) and the path `length`
 * to pass to `arcDraw`. A full circle is drawn as two half arcs (a single SVG arc cannot close on itself).
 */
export function ringArc({ size, radius, strokeWidth, fraction }: { size: number; radius: number; strokeWidth: number; fraction: number }): { source: string; length: number } {
  const f = Math.min(1, Math.max(0, fraction)), c = size / 2, angle = f * 2 * Math.PI
  const point = (a: number) => `${(c + radius * Math.sin(a)).toFixed(3)} ${(c - radius * Math.cos(a)).toFixed(3)}`
  const d = f >= 0.9999
    ? `M ${point(0)} A ${radius} ${radius} 0 1 1 ${point(Math.PI)} A ${radius} ${radius} 0 1 1 ${point(0)}`
    : `M ${point(0)} A ${radius} ${radius} 0 ${f > 0.5 ? 1 : 0} 1 ${point(angle)}`
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" fill="none"><path d="${d}" stroke="#000" stroke-width="${strokeWidth}" stroke-linecap="round"/></svg>`
  return { source, length: f * 2 * Math.PI * radius }
}

/**
 * A ring that shows `fraction` (0..1) of a circle and eases between values (`.rail-usage-arc`: `stroke-dashoffset` 400 ms
 * `--ease-out`), natively: the `<svg>` draws the whole ring as one closed path from 12 o'clock clockwise, and the native stroke
 * dashes it to `fraction` (`dasharray: C`, offset `C * (1 - fraction)`). A new `fraction` eases from the arc on screen (N2), with
 * no re-key and no render per frame; `drawIn` strokes it in from empty when it mounts (a ring's first value), otherwise it mounts
 * at its value (initial loads do not animate). Reduce Motion: value changes land at once. The stock addon gets the arc as its own
 * path (`ringArc`), with no motion.
 *
 * ```tsx
 * const ring = ringValue({ size: 24, radius: 10.25, strokeWidth: 2, fraction, drawIn: true })
 * <svg source={ring.source} {...(ring.paintAnimation ? { paintAnimation: ring.paintAnimation } : {})} style={{ width: 24, height: 24, color }} />
 * ```
 */
export function ringValue({ size, radius, strokeWidth, fraction, drawIn = false }: { size: number; radius: number; strokeWidth: number; fraction: number; drawIn?: boolean }): { source: string; paintAnimation?: StrokeAnimation } {
  const f = Math.min(1, Math.max(0, fraction))
  if (!PATCHED_NATIVE) return { source: ringArc({ size, radius, strokeWidth, fraction: f }).source }
  const ring = ringArc({ size, radius, strokeWidth, fraction: 1 })
  const length = Math.round(ring.length * 1000) / 1000, to = Math.round(length * (1 - f) * 1000) / 1000
  return {
    source: ring.source,
    paintAnimation: { kind: 'stroke', cycleMs: REDUCED_MOTION ? 1 : DURATION.slow * 1000, delayMs: 0, dash: length, ease: [...EASE.out], from: drawIn && !REDUCED_MOTION ? length : to, to, retarget: true },
  }
}
