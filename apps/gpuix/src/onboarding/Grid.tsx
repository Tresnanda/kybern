// The canvas behind every scene (SPEC §1): a flat theme canvas with a faint dot grid. No gradient, no aurora. The grid is one
// tinted SVG pattern (dots every 24 px) drawn full-bleed and faded toward the window edges with the native `edgeFade`. Every
// scene change pans it a few px and swells it once (the camera). Optionally a patch of darker dots follows the mouse (`LitGrid`).
import type { PaintTransformProps } from '@gpuix/native/host'
import { useWindowSize } from '@gpuix/react'
import { useMemo, useRef } from 'react'
import { EASE } from '../motion/tokens.ts'
import { EDGE_FADE, PATCHED_NATIVE } from '../native/local-build.ts'
import { useTheme, REDUCED_MOTION } from '../ui.tsx'
import type { Theme } from '../theme.ts'
import { bez } from './motion.tsx'
import { useFlow, type SceneId } from './flow.ts'

export const GRID = 24
/** The camera's pan per scene (SPEC §1). */
const PAN: Record<SceneId, [number, number]> = { hero: [0, 0], agents: [-12, -8], projects: [-24, 10], prefs: [-6, 18] }
const OVERSCAN = 72

export const canvasColor = (t: Theme) => (t.variant === 'dark' ? '#0b0b0c' : '#f3f3f4')
export const gridInk = (t: Theme) => (t.variant === 'dark' ? 'rgba(255, 255, 255, 0.07)' : 'rgba(13, 13, 13, 0.085)')
export const litInk = (t: Theme) => (t.variant === 'dark' ? 'rgba(255, 255, 255, 0.34)' : 'rgba(13, 13, 13, 0.32)')

/** A pattern of 1 px dots every `GRID` px, as an alpha mask the host tints. Quantized so a resize re-rasterizes in steps, not per pixel. */
export function gridSource(width: number, height: number): string {
  const w = Math.ceil(width / 96) * 96, h = Math.ceil(height / 96) * 96
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><pattern id="d" width="${GRID}" height="${GRID}" patternUnits="userSpaceOnUse"><circle cx="${GRID / 2}" cy="${GRID / 2}" r="0.7" fill="#000"/></pattern></defs><rect width="${w}" height="${h}" fill="url(#d)"/></svg>`
}

/** The camera: pans to the scene's offset over 1.4 s and swells once on every change (1.06 forward, 0.95 back, 1.1 s). */
function cameraPan(scene: SceneId): PaintTransformProps | undefined {
  if (!PATCHED_NATIVE) return undefined
  const [x, y] = PAN[scene]
  return { initial: false, animate: REDUCED_MOTION ? { opacity: 1 } : { translateX: x, translateY: y }, transition: { duration: REDUCED_MOTION ? 0.15 : 1.4, ease: bez(EASE.out) }, retain: true }
}
function cameraSwell(generation: number, dir: 1 | -1): PaintTransformProps | undefined {
  if (!PATCHED_NATIVE || REDUCED_MOTION) return undefined
  return { initial: { scale: 1 }, animate: { scale: 1 }, keyframes: [{ offset: 0.5, scale: dir > 0 ? 1.06 : 0.95 }], transition: { duration: 1.1, ease: bez(EASE.inOut) }, generation, retain: true }
}

export function Grid({ visible = true }: { visible?: boolean }) {
  const t = useTheme()
  const scene = useFlow((s) => s.scene)
  const dir = useFlow((s) => s.dir)
  const size = useWindowSize({ intervalMs: 300 })
  const w = size?.width ?? 1440, h = size?.height ?? 900
  const source = useMemo(() => gridSource(w + OVERSCAN * 2, h + OVERSCAN * 2), [Math.ceil(w / 96), Math.ceil(h / 96)])
  const swells = useRef({ scene, n: 0 })
  if (swells.current.scene !== scene) swells.current = { scene, n: swells.current.n + 1 }
  const fade = EDGE_FADE ? { edgeFade: { top: h * 0.18, bottom: h * 0.18, left: w * 0.18, right: w * 0.18 } } : {}
  return (
    <div style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, overflow: 'hidden', pointerEvents: 'none' }}>
      <div
        paintTransform={stateOpacity(visible)}
        style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, pointerEvents: 'none' }}
        {...fade}
      >
        <div paintTransform={cameraPan(scene)} style={{ position: 'absolute', left: -OVERSCAN, top: -OVERSCAN, pointerEvents: 'none' }}>
          <div paintTransform={cameraSwell(swells.current.n, dir)} style={{ pointerEvents: 'none' }}>
            <svg source={source} style={{ width: Math.ceil((w + OVERSCAN * 2) / 96) * 96, height: Math.ceil((h + OVERSCAN * 2) / 96) * 96, color: gridInk(t), pointerEvents: 'none' }} />
          </div>
        </div>
      </div>
    </div>
  )
}

/** The grid fades out in 600 ms when the flow hands off to the app. */
const stateOpacity = (visible: boolean): PaintTransformProps | undefined => PATCHED_NATIVE
  ? { initial: false, animate: { opacity: visible ? 1 : 0 }, transition: { duration: visible ? 0.3 : 0.6, ease: bez(EASE.out) }, retain: true }
  : undefined
