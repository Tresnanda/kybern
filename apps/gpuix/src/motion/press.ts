// Press feedback (`styles/motion.css` "Press feedback"): compact controls (buttons, icon buttons, toggles, chips)
// squash to `--scale-press` (0.97) on `:active`, over `--duration-micro` (80 ms) going down and `--duration-quick`
// (150 ms) coming back, both on `--ease-out`. Wide row-like controls (rows, full-width buttons, menu/select triggers)
// never scale, and Reduce Motion drops the scale (`scale: 1`).
//
// Patched native build (`native/patches/subtree_transform.rs`): `paintTransform.press` squashes the host's whole painted
// subtree about its centre on a primary mouse down and restores it on release, natively: no React state, no render or
// layout per frame, and hit testing follows the paint like a CSS transform. With the stock addon it does nothing.
import type { PaintTransformProps } from '@gpuix/native/host'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { REDUCED_MOTION } from '../ui.tsx'
import { DURATION, EASE } from './kit.tsx'

/** `--scale-press`. */
export const PRESS_SCALE = 0.97

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
