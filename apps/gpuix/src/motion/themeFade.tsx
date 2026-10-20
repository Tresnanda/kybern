// Theme switch cross-fade (`styles/motion.css`: `::view-transition-old/new(root)` 280 ms `--ease-smooth-out`; the desktop wraps
// the class flip in `startViewTransition`, and Reduce Motion drops the animation).
//
// GPUIX paints one scene per frame and cannot keep the old one under the new, so the old frame is held as a picture: the
// instant before the theme changes the window's current frame is captured (`captureScreenshot`, the previous colours: it
// renders the tree as it is now), and the new theme mounts with that picture above it, fading out as one native opacity tween
// (no JS per frame). The capture is synchronous (about 80 ms for a 1280 x 820 window at 2x); the switch itself waits for it.
//
// Callers (`setAppearance`, the system-appearance poll) call `snapshotBeforeThemeChange()` just before the preference flips;
// `ThemeFade` (mounted by `ThemeProvider`) shows what it captured.
import { motion } from '@gpuix/react'
import { existsSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { useSyncExternalStore } from 'react'
import { REDUCED_MOTION } from '../ui.tsx'
import { isWindowVisible } from '../native/visibility.ts'

/** `::view-transition-old/new(root)`. */
export const THEME_FADE_MS = 280
const SMOOTH_OUT: [number, number, number, number] = [0.22, 1, 0.36, 1]

interface Shot {
  key: number
  path: string
}
let renderer: { captureScreenshot?: (path: string) => void } | null = null
let shot: Shot | null = null
let count = 0
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

/** `ThemeProvider` hands over the window's renderer. */
export function installThemeFade(value: object | null | undefined) {
  renderer = (value as typeof renderer) ?? null
}

function clear(key?: number) {
  if (!shot || (key !== undefined && shot.key !== key)) return
  const old = shot.path
  shot = null
  emit()
  try { if (existsSync(old)) unlinkSync(old) } catch { /* A leftover temp file is harmless. */ }
}

/**
 * Capture the frame that is showing, before the theme changes. Does nothing under Reduce Motion, in a hidden window or
 * without the renderer; a failed capture just means the switch is instant.
 */
export function snapshotBeforeThemeChange() {
  if (REDUCED_MOTION || !renderer?.captureScreenshot || !isWindowVisible()) return
  clear()
  const file = path.join(tmpdir(), `kybern-theme-${process.pid}-${++count}.png`)
  try {
    renderer.captureScreenshot(file)
    if (existsSync(file)) {
      shot = { key: count, path: file }
      emit()
    }
  } catch (error) {
    console.error('[theme-fade] capture failed:', error)
  }
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
const current = () => shot

/** The old frame, above everything, fading to nothing (mount last in the window root). */
export function ThemeFade() {
  const picture = useSyncExternalStore(subscribe, current)
  if (!picture) return null
  return (
    <motion.div
      key={picture.key}
      testId="theme-fade"
      initial={{ opacity: 1 }}
      animate={{ opacity: 0 }}
      transition={{ duration: THEME_FADE_MS / 1000, ease: SMOOTH_OUT }}
      onMotionComplete={() => clear(picture.key)}
      style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
    >
      <img src={picture.path} alt="" objectFit="fill" style={{ width: '100%', height: '100%', pointerEvents: 'none' }} />
    </motion.div>
  )
}
