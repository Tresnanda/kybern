// Press feedback (`styles/motion.css` "Press feedback"): compact controls (buttons, icon buttons, toggles, chips)
// squash to `--scale-press` (0.97) on `:active`, over `--duration-micro` (80 ms) going down and `--duration-quick`
// (150 ms) coming back, both on `--ease-out`. Wide row-like controls (rows, full-width buttons, menu/select triggers)
// never scale, and Reduce Motion drops the scale (`scale: 1`).
//
// Patched native build (`native/patches/subtree_transform.rs`): `paintTransform.press` squashes the host's whole painted
// subtree about its centre on a primary mouse down and restores it on release, natively: no React state, no render or
// layout per frame, and hit testing follows the paint like a CSS transform. With the stock addon it does nothing.
import type { StyleDesc } from '@gpuix/react'
import type { PaintTransformProps } from '@gpuix/native/host'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { REDUCED_MOTION } from '../ui.tsx'
import type { Theme } from '../theme.ts'
import { DURATION, EASE, SCALE } from './tokens.ts'

/** `--scale-press`. */
export const PRESS_SCALE: number = SCALE.press

const presses = new Map<string, PaintTransformProps>()

/**
 * The `paintTransform` prop for a pressable compact control; undefined when disabled, wide or under Reduce Motion. `scale`,
 * `down` and `up` (seconds; default `--duration-micro` / `--duration-quick`) are for the few desktop controls with their own
 * press CSS (`tasks.css`: `.tk-nav-disclose` 0.96 over 150 ms both ways, the selection bar's `.primary` 0.97 over 80 ms both
 * ways and its `.tk-btn` 0.97 with no transition).
 */
export function pressTransform(enabled = true, scale = PRESS_SCALE, down?: number, up?: number): PaintTransformProps | undefined {
  if (!enabled || !PATCHED_NATIVE || REDUCED_MOTION) return undefined
  // Built on first use: `ui.tsx` imports this module, and `motion/kit.tsx` imports `ui.tsx`.
  const downS = down ?? DURATION.micro, upS = up ?? DURATION.quick, key = `${scale}:${downS}:${upS}`
  let press = presses.get(key)
  if (!press) {
    press = {
      initial: false,
      animate: {},
      press: {
        scale,
        down: { duration: downS, ease: [...EASE.out] },
        up: { duration: upS, ease: [...EASE.out] },
      },
    }
    presses.set(key, press)
  }
  return press
}

// ─── Rows: darken, never scale ─────────────────────────────────────────────

/** Multiplies a colour's RGB by `factor` and keeps its alpha, like CSS `filter: brightness(factor)`. Unparseable input is returned as is. */
export function shade(color: string, factor: number): string {
  const rgb = color.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i)
  let r: number, g: number, b: number, a: number
  if (rgb) {
    ;[r, g, b] = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
    a = rgb[4] === undefined ? 1 : rgb[4].endsWith('%') ? Number.parseFloat(rgb[4]) / 100 : Number(rgb[4])
  } else {
    const hex = color.match(/^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i)?.[1]
    if (!hex) return color
    const full = hex.length <= 4 ? [...hex].map(c => c + c).join('') : hex
    r = Number.parseInt(full.slice(0, 2), 16)
    g = Number.parseInt(full.slice(2, 4), 16)
    b = Number.parseInt(full.slice(4, 6), 16)
    a = full.length === 8 ? Number.parseInt(full.slice(6, 8), 16) / 255 : 1
  }
  const channel = (v: number) => Math.min(255, Math.max(0, Math.round(v * factor)))
  return `rgba(${channel(r)}, ${channel(g)}, ${channel(b)}, ${Math.round(a * 1000) / 1000})`
}

/**
 * `.press-row:active` (`motion.css:128`): wide row-like controls never scale, they darken (`brightness(0.96)`; `1.08` in the dark
 * theme) while held, instantly. Spread it into the row's `style` next to its `hover`: `style={{ ..., hover: {...}, ...pressRowStyle(t, rest) }}`,
 * where `rest` is the fill the row shows while hovered (`t.buttonTertiaryHover`, `t.hover`, ...). A style (not a `paintTransform`) so
 * the native `active` state paints it with no React state, like `ChromeButton`. Not motion, so Reduce Motion leaves it on.
 */
export function pressRowStyle(t: Theme, rest: string): StyleDesc {
  return { active: { backgroundColor: shade(rest, t.variant === 'dark' ? 1.08 : 0.96) } }
}

// ─── Prominent buttons: grow on hover ─────────────────────────────────────

const hovers = new Map<string, PaintTransformProps>()

/**
 * `button.tsx:108` `hover:scale-105` on prominent buttons (send, primary actions): `hover` grows the control to 1.05 over
 * `--duration-quick` on `--ease-out` and back; the press squash of `pressTransform` (0.97, 80 ms down / 150 ms up) still applies
 * on top of the hover scale. One React render per hover change (`hover` is state from `onMouseEnter`/`onMouseLeave`); the tween
 * itself is paint-only. `undefined` when disabled, with the stock addon or under Reduce Motion (no hover scale, no press).
 */
export function hoverPressTransform(hover: boolean, enabled = true): PaintTransformProps | undefined {
  const press = pressTransform(enabled)
  if (!press) return undefined
  const key = String(hover)
  let props = hovers.get(key)
  if (!props) {
    props = { ...press, animate: { scale: hover ? 1.05 : 1 }, transition: { duration: DURATION.quick, ease: [...EASE.out] } }
    hovers.set(key, props)
  }
  return props
}
