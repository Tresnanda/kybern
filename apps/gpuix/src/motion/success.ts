// Success check (`.t-success`, `styles/motion.css`): the icon fades in, rotates from -20° and bobs up while it resolves
// from a 2px blur: `--duration-very-slow` (500 ms) on `--ease-smooth-out`, keyframes 0% (opacity 0, rotate(-20deg)
// scale(0.8) translateY(2px), blur 2px), 60% (rotate(4deg) scale(1.06) translateY(-1px)), 100% (rest). Painted natively
// with no render or layout per frame (`paintTransform` keyframes, `native/patches/subtree_transform.rs`); the glyph
// rotates exactly. Reduce Motion (`.t-success { animation: none }`) shows it at rest. The desktop also draws the check's
// stroke (`stroke-dashoffset`), which GPUIX SVGs cannot animate: the glyph appears whole.
import type { PaintTransformProps } from '@gpuix/native/host'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { REDUCED_MOTION } from '../ui.tsx'
import { DURATION, EASE } from './kit.tsx'

export function successTransform(): PaintTransformProps | undefined {
  if (!PATCHED_NATIVE || REDUCED_MOTION) return undefined
  return {
    initial: { opacity: 0, rotate: -20, scale: 0.8, translateY: 2, blur: 2 },
    animate: { opacity: 1, rotate: 0, scale: 1, translateY: 0, blur: 0 },
    keyframes: [{ offset: 0.6, rotate: 4, scale: 1.06, translateY: -1 }],
    transition: { duration: DURATION.verySlow, ease: [...EASE.smoothOut] },
  }
}
