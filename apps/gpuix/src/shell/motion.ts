// Small motion helpers shared by the shell, rail, sidebar and dialogs (P1). Everything here is a value or a `paintTransform`
// builder: no timers, no state, nothing that renders per frame.
import type { PaintTransformProps } from '@gpuix/native/host'
import type { StyleDesc } from '@gpuix/react'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { BLUR, DURATION, EASE } from '../motion/tokens.ts'
import type { Theme } from '../theme.ts'
import { REDUCED_MOTION } from '../ui.tsx'

/**
 * An opacity change that eases instead of cutting (`transition-opacity duration-150`, `disabled:opacity-40`): the control's
 * `paintTransform` and the `opacity` its `style` must carry. The tween is paint-only; under Reduce Motion (an opacity change that
 * is a state, not motion, stays instant) and with the stock addon the opacity is in the style and changes at once.
 *
 * ```tsx
 * const dim = fadeTo(stale ? 0.5 : 1)
 * <div paintTransform={dim.paintTransform} style={{ ...base, ...dim.style }} />
 * ```
 */
export function fadeTo(opacity: number, duration: number = DURATION.quick): { paintTransform: PaintTransformProps | undefined; style: StyleDesc } {
  if (!PATCHED_NATIVE || REDUCED_MOTION) return { paintTransform: undefined, style: { opacity } }
  return { paintTransform: { initial: false, animate: { opacity }, transition: { duration, ease: [...EASE.out] } }, style: {} }
}

/** `[r, g, b, a]` of an `rgb()`/`rgba()`/hex colour, or null. */
function parse(color: string): [number, number, number, number] | null {
  const rgb = color.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i)
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] === undefined ? 1 : rgb[4].endsWith('%') ? Number.parseFloat(rgb[4]) / 100 : Number(rgb[4])]
  const hex = color.match(/^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i)?.[1]
  if (!hex) return null
  const full = hex.length <= 4 ? [...hex].map(c => c + c).join('') : hex
  return [Number.parseInt(full.slice(0, 2), 16), Number.parseInt(full.slice(2, 4), 16), Number.parseInt(full.slice(4, 6), 16), full.length === 8 ? Number.parseInt(full.slice(6, 8), 16) / 255 : 1]
}

/**
 * The fill of a row while it is held (`.press-row:active`, `filter: brightness(0.96)`; 1.08 in the dark theme). GPUIX cannot filter
 * what a row paints, and the sidebar's hover fills are white/black washes at about 4 % alpha: multiplying their RGB (what
 * `pressRowStyle` does) changes nothing visible in the dark theme (252 → 255). A washed fill is darkened/lightened the way it was
 * made, by strengthening the wash: `rest` with its alpha ×2.2 (the sidebar's 4 % hover reads as ~8.6 % under the pointer), which is
 * a step of the same size as brightness 0.96 on the light theme's surface and visible on the dark one. An opaque `rest` takes the
 * desktop's brightness factors. Instant, like the desktop, and not motion, so Reduce Motion leaves it on.
 */
export function pressFill(t: Theme, rest: string): string {
  const c = parse(rest)
  if (!c) return rest
  const [r, g, b, a] = c
  if (a < 1) return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${Math.round(Math.min(1, a * 2.2) * 1000) / 1000})`
  const k = t.variant === 'dark' ? 1.08 : 0.96
  const ch = (v: number) => Math.min(255, Math.max(0, Math.round(v * k)))
  return `rgba(${ch(r)}, ${ch(g)}, ${ch(b)}, 1)`
}

/** Spread into a row's `style` next to its hover fill: `{ ..., ...pressRow(t, hoverFill) }`. Native `:active`, no React state. */
export function pressRow(t: Theme, rest: string): StyleDesc {
  return { active: { backgroundColor: pressFill(t, rest) } }
}

/**
 * The thread panel is a drawer (`sidebar.tsx:40-48`): it opens in 260 ms and closes in 200 ms on `--ease-drawer` (a fast start and a long
 * settle). The title bar's title column moves with its edge on the same timing. A layout (width/left) tween: the frame-rate lane
 * owns its cost (F7), the mechanism is not changed here.
 */
export const drawerSlide = (open: boolean) => ({ duration: open ? 0.26 : 0.2, ease: [...EASE.drawer] as [number, number, number, number] })

/** `t-icon-swap` entrance on its own (a glyph that appears with nothing to swap with): scale 0.6 and a 2 px blur → rest, opacity 0 → 1, 250 ms ease-in-out. Reduce Motion fades. */
export function iconEnter(): PaintTransformProps | undefined {
  if (!PATCHED_NATIVE) return undefined
  const ease = [...EASE.inOut] as [number, number, number, number]
  if (REDUCED_MOTION) return { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: DURATION.quick, ease } }
  return { initial: { opacity: 0, scale: 0.6, blur: BLUR.small }, animate: { opacity: 1, scale: 1, blur: 0 }, transition: { duration: DURATION.fast, ease } }
}
