// Exits for anything that unmounts. GPUIX removes a React child at once, so a dismissed popup, card or row has no leaving
// frame unless its owner keeps it mounted. `Presence` keeps the last children while `show` is false, tweens them to an exit
// state with `paintTransform` (paint-only: no layout, render or island work per frame), then unmounts. `requests/Panel.tsx`
// `PanelPresence` is the older layout-tween version of the same idea.
import type { PaintTransformProps, PaintTransformValue } from '@gpuix/native/host'
import type { StyleDesc } from '@gpuix/react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { isWindowVisible } from '../native/visibility.ts'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { REDUCED_MOTION } from '../ui.tsx'
import { DURATION, EASE, type Ease } from './tokens.ts'

/** Where a leaving element goes (`to`) and how: seconds and a cubic-bezier (default `--ease-smooth-out`). */
export type Exit = { to: PaintTransformValue; duration: number; ease?: Ease }

/**
 * The desktop's exits, by role. They share the enter curve and run ~30-40% faster than the matching enter (the desktop keeps
 * one set of easings; do not fork the identity). Keyboard-driven callers pass `{ ...EXIT.menu, duration: 0 }` to unmount at once.
 */
export const EXIT = {
  /** Menu, popover, select popup (`data-ending-style`). */
  menu: { to: { opacity: 0, scale: 0.99 }, duration: 0.15 },
  tooltip: { to: { opacity: 0, scale: 0.98 }, duration: 0.08 },
  dialog: { to: { opacity: 0, scale: 0.98 }, duration: 0.15 },
  backdrop: { to: { opacity: 0 }, duration: 0.15 },
  /** A work row or card leaving a list: fades and lifts 4 px. */
  row: { to: { opacity: 0, translateY: -4 }, duration: 0.15 },
  /** A hover-revealed control (`t-reveal`, pair with `revealTransform`). */
  reveal: { to: { opacity: 0 }, duration: 0.1 },
  /** A tab's content that was switched away from. */
  pane: { to: { opacity: 0, translateY: 4, scale: 0.995 }, duration: 0.15 },
} as const satisfies Record<string, Exit>

/** What a `paintTransform` rests at, with every field set (so a retarget back from any exit lands exactly there). */
const REST: PaintTransformValue = { opacity: 1, scale: 1, scaleX: 1, scaleY: 1, shadowOpacity: 1, rotate: 0, translateX: 0, translateY: 0, blur: 0 }
const ENTER_DEFAULT = { duration: DURATION.quick, ease: [...EASE.out] as [number, number, number, number] }

let presenceGeneration = 4_000_000
/** A fresh native motion generation: completion events carry it, so a stale event can be told from the one being waited for. */
export const nextPresenceGeneration = () => ++presenceGeneration

/**
 * The `paintTransform` of an element that can leave. `show` rests it at `enter.animate` (identity by default) and tweens back from
 * wherever it is when it returns; `!show` tweens to `exit.to`. `enter` is the element's entrance (`enterTransform`,
 * `popupTransform`, ...); its `initial` is used only on the render that mounts the element (`fresh`). `generation` must change
 * whenever `show` does (the native side reports completion per generation and, with no `initial`, retargets from the value on
 * screen). Reduce Motion exits by fading out over 100 ms. Returns `undefined` with the stock addon.
 */
export function presenceTransform({ show, enter, exit, generation, fresh }: { show: boolean; enter?: PaintTransformProps; exit: Exit; generation: number; fresh: boolean }): PaintTransformProps | undefined {
  if (!PATCHED_NATIVE) return undefined
  const leave: Exit = REDUCED_MOTION ? { to: { opacity: 0 }, duration: 0.1 } : exit
  return {
    initial: fresh && enter?.initial ? enter.initial : false,
    animate: show ? { ...REST, ...enter?.animate } : leave.to,
    transition: show ? { ...ENTER_DEFAULT, ...enter?.transition } : { duration: leave.duration, ease: [...(leave.ease ?? EASE.smoothOut)] as [number, number, number, number] },
    ...(enter?.origin ? { origin: enter.origin } : {}),
    ...(show && fresh && enter?.keyframes ? { keyframes: enter.keyframes } : {}),
    generation,
    // Shown is the rest (identity): stay retained, so the exit is paint-only from its first frame instead of a render.
    retain: true,
  }
}

/** Whether a leaving element can skip its exit: no native tweens, an instant exit, or a hidden window (native frames do not run, so completion would never arrive). */
export function exitsInstantly(exit: Exit): boolean {
  return !PATCHED_NATIVE || exit.duration <= 0 || !isWindowVisible()
}

/**
 * Keeps `children` mounted through an exit. While `show` is true it renders them (with the `enter` transform on mount); when
 * `show` turns false it keeps rendering the last children, non-interactive (`pointerEvents: 'none'`), tweens them to `exit.to`
 * and unmounts when the tween completes, then calls `onGone`. Showing again mid-exit retargets back to rest from where it is
 * (interruptible, no restart). Unmounts at once when the window is hidden, the addon is stock, or `exit.duration` is 0 (the
 * keyboard path: `exit={{ ...EXIT.menu, duration: 0 }}`).
 *
 * ```tsx
 * <Presence show={open} enter={popupTransform()} exit={EXIT.menu}><Menu /></Presence>
 * ```
 */
export function Presence({ show, enter, exit, children, onGone, testId, style }: {
  show: boolean
  enter?: PaintTransformProps
  exit: Exit
  children: ReactNode
  onGone?: () => void
  testId?: string
  style?: StyleDesc
}) {
  const last = useRef<ReactNode>(null)
  const [present, setPresent] = useState(show)
  const generation = useRef(show ? nextPresenceGeneration() : 0)
  // The generation the element mounted with: `initial` is only valid then (a new generation with an `initial` would restart from it).
  const mounted = useRef(generation.current)
  const previous = useRef(show)
  const wasPresent = useRef(present)
  if (show) last.current = children
  if (show && !present) {
    setPresent(true)
    generation.current = mounted.current = nextPresenceGeneration()
    previous.current = true
  } else if (previous.current !== show) {
    previous.current = show
    generation.current = nextPresenceGeneration()
  }
  const gone = !show && present && exitsInstantly(exit)
  if (gone) {
    last.current = null
    setPresent(false)
  }
  useEffect(() => {
    if (wasPresent.current && !present) onGone?.()
    wasPresent.current = present
  }, [present, onGone])
  // The exit normally ends on `onMotionComplete`; this only guarantees the unmount if a layer never reports (ADE-70).
  useEffect(() => {
    if (show || !present) return
    const timer = setTimeout(() => { last.current = null; setPresent(false) }, exit.duration * 1000 + 250)
    return () => clearTimeout(timer)
  }, [show, present, exit.duration])
  if (gone || (!show && !present)) return null
  const current = generation.current
  return (
    <div
      testId={testId}
      paintTransform={presenceTransform({ show, enter, exit, generation: current, fresh: current === mounted.current })}
      onMotionComplete={event => {
        if (show || event.motionGeneration !== current) return
        last.current = null
        setPresent(false)
      }}
      style={{ display: 'flex', flexDirection: 'column', ...style, ...(show ? {} : { pointerEvents: 'none' }) }}
    >
      {show ? children : last.current}
    </div>
  )
}
