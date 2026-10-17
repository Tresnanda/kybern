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

let press: PaintTransformProps | undefined

/** The `paintTransform` prop for a pressable compact control; undefined when disabled, wide or under Reduce Motion. */
export function pressTransform(enabled = true): PaintTransformProps | undefined {
  if (!enabled || !PATCHED_NATIVE || REDUCED_MOTION) return undefined
  // Built on first use: `ui.tsx` imports this module, and `motion/kit.tsx` imports `ui.tsx`.
  return (press ??= {
    initial: false,
    animate: {},
    press: {
      scale: PRESS_SCALE,
      down: { duration: DURATION.micro, ease: [...EASE.out] },
      up: { duration: DURATION.quick, ease: [...EASE.out] },
    },
  })
}
