// What every scene shares besides motion: its heading takes focus when the scene arrives (so a screen reader announces it), and
// ⌘↵ / Ctrl+Enter presses the scene's primary button.
import { useGpuixRequired, type PublicInstance } from '@gpuix/react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { onFrame } from '../native/frame.ts'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { isWindowVisible } from '../native/visibility.ts'
import { addWindowKeyHandler } from '../nav/keys.ts'
import { isPrimaryChord } from '../platform/keys.ts'
import { useFlow, type SceneId } from './flow.ts'
import { skippedOpen } from './SkippedDialog.tsx'

/** Long enough for the arriving scene to be laid out and the old one's focus to have left with it. */
const FOCUS_DELAY_MS = 90

/**
 * The scene's heading. It is the focus target of a scene change, not a tab stop (`tabIndex={-1}`), and it declares no focus
 * style, so the app's focus model draws no ring on it (rings are for keyboard focus on controls).
 */
export function SceneHeading({ id, label, children }: { id: SceneId; label: string; children: ReactNode }) {
  const renderer = useGpuixRequired()
  const node = useRef<PublicInstance | null>(null)
  const current = useFlow((s) => s.scene === id)
  useEffect(() => {
    if (!current) return
    const timer = setTimeout(() => { if (node.current) renderer.focusElement?.(node.current.id) }, FOCUS_DELAY_MS)
    return () => clearTimeout(timer)
  }, [current, renderer])
  return (
    <div ref={node} testId={`onboarding-heading-${id}`} role="heading" aria-level={1} aria-label={label} tabIndex={-1} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      {children}
    </div>
  )
}

/** The key that runs a primary: ⌘↵ on macOS, Ctrl+Enter elsewhere. */
export const isPrimaryEnter = (event: { key?: string; modifiers?: { cmd?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean } | null }) =>
  event.key === 'enter' && isPrimaryChord(event.modifiers)

/** Register the scene's primary for ⌘↵ while the scene is current. `run` is null while the primary is disabled or something else owns the keys. */
export function useScenePrimary(id: SceneId, run: (() => void) | null) {
  const current = useFlow((s) => s.scene === id)
  const latest = useRef(run)
  latest.current = run
  useEffect(() => {
    if (!current) return
    return addWindowKeyHandler((event) => {
      if (!isPrimaryEnter(event) || !latest.current || skippedOpen()) return false
      latest.current()
      return true
    })
  }, [current])
}

/**
 * Mounts `children` `frames` display frames after itself, holding their place with `placeholder` until then. A scene's first draw
 * builds, shapes and rasterizes everything in it at once (30 ms for the Agents scene); its heavy parts are not visible that early
 * (they fade in from 0 after a delay), so they mount a frame or two later and the cost is spread. Stock addon or a hidden window:
 * at once.
 */
export function Later({ frames = 1, children, placeholder = null }: { frames?: number; children: ReactNode; placeholder?: ReactNode }) {
  const [ready, setReady] = useState(frames <= 0 || !PATCHED_NATIVE || !isWindowVisible())
  useEffect(() => {
    if (ready) return
    let n = 0
    const stop = onFrame(() => { if (++n >= frames) { stop(); setReady(true) } })
    // A window that stops drawing (hidden mid-change) must not leave the scene half built.
    const timer = setTimeout(() => { stop(); setReady(true) }, 250)
    return () => { stop(); clearTimeout(timer) }
  }, [ready, frames])
  return <>{ready ? children : placeholder}</>
}
