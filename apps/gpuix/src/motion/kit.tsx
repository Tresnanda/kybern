// The desktop's motion system (`styles/motion.css`, `lib/kit/disclosureMotion.ts`)
// on GPUIX's native tweens. `motion.div` interpolates in Rust, so no React or
// JS work runs per frame; only the start and end of a transition cross over.
//
// GPUIX tweens opacity, width, height, top/left and borderRadius. The desktop's
// `scale(0.97)` and `blur(2px)` starting states have no equivalent, so each
// entrance keeps the desktop's opacity, distance, duration and curve, and the
// scale/blur part is dropped rather than imitated.
//
// Cost model (perf/README.md): every animation frame re-lays out the window, so
// transitions are short bursts and loops stay on MatrixLoader's paused-when-
// hidden clock. Reduce Motion keeps fades and drops movement, like the desktop.
import { motion, useGpuixRequired, type PublicInstance, type StyleDesc } from '@gpuix/react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { REDUCED_MOTION } from '../ui.tsx'

/** `--duration-*` in seconds. */
export const DURATION = { micro: 0.08, quick: 0.15, fast: 0.25, medium: 0.35, slow: 0.4, verySlow: 0.5 } as const
/** `--ease-*` cubic-bezier control points. */
export const EASE = {
  smoothOut: [0.22, 1, 0.36, 1],
  out: [0.23, 1, 0.32, 1],
  inOut: [0.77, 0, 0.175, 1],
  drawer: [0.32, 0.72, 0, 1],
} as const satisfies Record<string, [number, number, number, number]>
/** `--distance-*` in px. */
export const DISTANCE = { micro: 4, small: 6, base: 8, medium: 12 } as const
/** `DISCLOSURE_TRANSITION_MS`. */
export const DISCLOSURE = 0.22

type Ease = readonly [number, number, number, number]
const tween = (duration: number, ease: Ease, delay = 0) => ({ duration, ease: [...ease] as [number, number, number, number], delay })

// ─── Entrances ────────────────────────────────────────────────────────────

/** The desktop's enter-only keyframes, by name. */
export const ENTER = {
  /** `t-row-enter`: work rows appearing in a live turn. */
  row: { distance: DISTANCE.micro, duration: DURATION.fast },
  /** `t-panel-enter`: cards stacked above the composer. */
  panel: { distance: DISTANCE.base, duration: DURATION.medium },
  /** `t-section-enter`: keyed remounts (settings sections, pages). */
  section: { distance: DISTANCE.small, duration: DURATION.fast },
  /** `t-stagger`: the home heading lines, 70 ms apart. */
  stagger: { distance: DISTANCE.medium, duration: DURATION.verySlow },
  /** `chat-message-send-enter` (kit.css:337): the bubble the user just sent, 260 ms. */
  send: { distance: DISTANCE.small, duration: 0.26 },
} as const

/**
 * Fade up into place once, on mount. `play={false}` renders plainly (rows that
 * were already there, history pages): the desktop only animates fresh content.
 */
export function Rise({
  children,
  kind = 'row',
  index = 0,
  play = true,
  style,
  testId,
}: {
  children: ReactNode
  kind?: keyof typeof ENTER
  /** Position in a staggered group (`t-stagger` uses index × 70 ms). */
  index?: number
  play?: boolean
  style?: StyleDesc
  testId?: string
}) {
  const { distance, duration } = ENTER[kind]
  if (!play) return <div testId={testId} style={{ display: 'flex', flexDirection: 'column', ...style }}>{children}</div>
  const delay = kind === 'stagger' ? index * 0.07 : 0
  return (
    <motion.div
      initial={{ opacity: 0, top: REDUCED_MOTION ? 0 : distance }}
      animate={{ opacity: 1, top: 0 }}
      transition={tween(REDUCED_MOTION ? DURATION.quick : duration, EASE.smoothOut, delay)}
      style={{ display: 'flex', flexDirection: 'column', position: 'relative', ...style }}
    >
      {testId ? <div testId={testId} style={{ display: 'flex', flexDirection: 'column' }}>{children}</div> : children}
    </motion.div>
  )
}

// ─── Popups ───────────────────────────────────────────────────────────────

/** Menu (`menu.tsx`) and tooltip (`tooltip.tsx`) open timings. */
export const POPUP = {
  menu: { duration: DURATION.fast, ease: EASE.smoothOut, distance: DISTANCE.micro },
  tooltip: { duration: DURATION.quick, ease: EASE.out, distance: DISTANCE.micro / 2 },
} as const

/**
 * Wrap a popup's content (inside its `<anchored>` / Select / Combobox surface).
 * It fades in and drifts from the trigger side, standing in for the desktop's
 * scale from `--transform-origin`. `side` is where the popup sits relative to
 * its trigger. Closing is instant (unmount), like a dismissed Base UI popup
 * that the user has already moved on from.
 */
export function Popup({ children, side = 'bottom', kind = 'menu', style }: { children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right'; kind?: keyof typeof POPUP; style?: StyleDesc }) {
  const { duration, ease, distance } = POPUP[kind]
  const d = REDUCED_MOTION ? 0 : distance
  const from = side === 'bottom' ? { top: -d } : side === 'top' ? { top: d } : side === 'right' ? { left: -d } : { left: d }
  return (
    <motion.div
      initial={{ opacity: 0, ...from }}
      animate={{ opacity: 1, top: 0, left: 0 }}
      transition={tween(duration, ease)}
      style={{ display: 'flex', flexDirection: 'column', position: 'relative', ...style }}
    >
      {children}
    </motion.div>
  )
}

// ─── Disclosure ───────────────────────────────────────────────────────────

/**
 * `disclosureShellClassName`: content opens and closes with a 220 ms height
 * and opacity tween (ease-out). GPUIX tweens need a numeric height, so the
 * content is measured after its first paint, animated to that height, then
 * left at its natural height. Closing measures, animates to 0, then unmounts
 * the children (desktop: "unmount closed details after their exit").
 *
 * Pass `height` when the content height is known (e.g. N sidebar rows × 30):
 * no measuring frame is needed.
 */
let disclosureGeneration = 2_000_000
export function Collapse({ open, children, height: known, testId, closeDuration }: { open: boolean; children: ReactNode; height?: number; testId?: string; /** Closing is faster than opening when set (toasts leave in 160 ms). */ closeDuration?: number }) {
  const renderer = useGpuixRequired()
  const inner = useRef<PublicInstance>(null)
  // 'open': natural height. 'opening'/'closing': tweening. 'closed': unmounted.
  const [phase, setPhase] = useState<'open' | 'opening' | 'closing' | 'closed'>(open ? 'open' : 'closed')
  const [from, setFrom] = useState(0)
  const [to, setTo] = useState<number | null>(null)
  const [generation, setGeneration] = useState(0)
  const lastOpen = useRef<number | null>(known ?? null)

  const measure = () => {
    const id = inner.current?.id
    const bounds = id != null ? renderer.getElementBounds?.(id) : null
    return bounds ? bounds.height : null
  }

  useLayoutEffect(() => {
    if (REDUCED_MOTION) {
      setPhase(open ? 'open' : 'closed')
      return
    }
    if (open && (phase === 'closed' || phase === 'closing')) {
      // From 'closed' the element mounts fresh; from 'closing' it is reused and
      // tweens back from its current height.
      setFrom(phase === 'closing' ? (measure() ?? 0) : 0)
      setTo(known ?? (phase === 'closing' ? lastOpen.current : null))
      setPhase('opening')
    } else if (!open && (phase === 'open' || phase === 'opening')) {
      const h = phase === 'open' ? (measure() ?? known ?? 0) : (measure() ?? to ?? 0)
      lastOpen.current = h || lastOpen.current
      setFrom(h)
      setTo(0)
      setPhase('closing')
      if (phase === 'open') setGeneration((g) => g + 1)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Opening with an unknown height: measure the inner content after it paints.
  useEffect(() => {
    if (phase !== 'opening' || to !== null) return
    let tries = 0
    const tick = () => {
      const h = measure()
      if (h != null && h > 0) {
        lastOpen.current = h
        setTo(h)
      }
      else if (++tries < 10) timer = setTimeout(tick, 16)
      else setPhase('open')
    }
    let timer = setTimeout(tick, 16)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, to, generation])

  const nativeGeneration = useMemo(() => ++disclosureGeneration, [phase, from, to, generation])
  if (REDUCED_MOTION) return open ? <div testId={testId} style={{ display: 'flex', flexDirection: 'column', flexShrink: 0 }}>{children}</div> : null
  if (phase === 'closed') return null
  // One element carries the content from the start of an opening through its
  // whole open life, so settling never remounts the children (their state
  // survives). Only a close that starts from the settled state takes a fresh
  // element, which needs a numeric starting height; the content is leaving.
  const settled = phase === 'open'
  return (
    <div
      // Remove the motion descriptor when settled: the native host otherwise
      // retains the last animated numeric height when children grow later.
      // Keep this host and its children mounted across the whole disclosure.
      {...((settled ? {} : { motion: {
        generation: nativeGeneration,
        isExit: false,
        initial: { height: from, opacity: phase === 'opening' ? 0 : 1 },
        animate: { height: to ?? from, opacity: phase === 'opening' ? (to === null ? 0 : 1) : 0 },
        transition: tween(phase === 'closing' && closeDuration ? closeDuration : DISCLOSURE, EASE.out),
      } }) as object)}
      onMotionComplete={event => {
        if (event.motionGeneration !== nativeGeneration) return
        if (phase === 'opening' && to !== null) setPhase('open')
        if (phase === 'closing') setPhase('closed')
      }}
      style={{ display: 'flex', flexDirection: 'column', overflow: settled ? undefined : 'hidden', flexShrink: 0 }}
    >
      <div ref={inner} testId={testId} style={{ display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
        {children}
      </div>
    </div>
  )
}

// ─── Swaps ────────────────────────────────────────────────────────────────

/**
 * `IconSwap` / `TextSwap`: the new state fades up in place (copy → check,
 * send → spinner) over `--duration-fast`. GPUIX cannot overlap the outgoing
 * state without taking it out of layout, so it leaves instantly.
 */
export function Swap({ active, children, style }: { active: string; children: ReactNode; style?: StyleDesc }) {
  return (
    <motion.div
      key={active}
      initial={{ opacity: 0, top: REDUCED_MOTION ? 0 : 2 }}
      animate={{ opacity: 1, top: 0 }}
      transition={tween(DURATION.fast, EASE.smoothOut)}
      style={{ display: 'flex', position: 'relative', alignItems: 'center', justifyContent: 'center', ...style }}
    >
      {children}
    </motion.div>
  )
}
