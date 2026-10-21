// Small motion primitives on top of styles/motion.css: the matrix dot loader,
// per-word streaming reveal, text and icon swaps, the presence hook for
// `.t-appear` and the loop-visibility ref hook. Everything here is
// transform/opacity/filter only and honours prefers-reduced-motion through the
// stylesheet.

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react"

import { advanceIconSwap, ICON_SWAP_QUICK_MS, ICON_SWAP_TRANSITION_MS, settleIconSwap, type IconSwapKey, type IconSwapState } from "@/lib/iconSwap"
import { observeLoopVisibility } from "@/lib/loopVisibility"
import { cn } from "@/lib/utils"

/* ─── Presence ──────────────────────────────────────────────────────────── */

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)"
const DEFAULT_EXIT_MS = 150

/** `--duration-quick` in ms, read from the stylesheet so timer and CSS stay in step. */
function quickDurationMs(): number {
  if (typeof document === "undefined") return DEFAULT_EXIT_MS
  const value = getComputedStyle(document.documentElement).getPropertyValue("--duration-quick").trim()
  const ms = value.endsWith("ms") ? parseFloat(value) : parseFloat(value) * 1000
  return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_EXIT_MS
}

/**
 * Keeps a node mounted for `exitMs` after `show` turns false so `[data-leaving]`
 * styles can run. Mounts on the same render `show` turns true; on false it sets
 * `leaving`, then unmounts after `exitMs` (default `--duration-quick`), cancelled
 * if `show` returns first (the node retargets back in). With reduced motion
 * there is no exit delay. Render:
 *
 *   const { mounted, leaving } = usePresence(open)
 *   {mounted && <div className="t-appear" data-leaving={leaving || undefined}>…</div>}
 *
 * Pair with `.t-appear` (or `.t-pop` / `.t-pop-out`). Initial mount with
 * `show` already true also enters through `@starting-style`, so gate the
 * element on a "fresh" signal when a first paint must not animate.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function usePresence(show: boolean, exitMs?: number): { mounted: boolean; leaving: boolean } {
  const [state, setState] = useState({ mounted: show, leaving: false })
  // Adjust during render so the mount and the leave start on the same frame.
  if (show && (!state.mounted || state.leaving)) {
    setState({ mounted: true, leaving: false })
  } else if (!show && state.mounted && !state.leaving) {
    const reduced = typeof window !== "undefined" && window.matchMedia(REDUCED_MOTION_QUERY).matches
    setState(reduced ? { mounted: false, leaving: false } : { mounted: true, leaving: true })
  }
  const leavingNow = state.leaving && !show
  useEffect(() => {
    if (!leavingNow) return
    const id = window.setTimeout(() => setState({ mounted: false, leaving: false }), exitMs ?? quickDurationMs())
    return () => window.clearTimeout(id)
  }, [leavingNow, exitMs])
  return { mounted: show || state.mounted, leaving: leavingNow }
}

/**
 * Callback ref that pauses a looping element's animation while it is clipped,
 * offscreen or in a hidden window (it toggles `[data-loop-paused]`; the motion
 * stylesheet pauses `.t-shimmer`, `.animate-skeleton` and friends on it).
 * `<span ref={useLoopVisibility()} className="t-shimmer">`.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useLoopVisibility<T extends HTMLElement>(enabled = true): (node: T | null) => void {
  const stop = useRef<(() => void) | null>(null)
  return useCallback(
    (node: T | null) => {
      stop.current?.()
      stop.current = node && enabled ? observeLoopVisibility(node) : null
    },
    [enabled],
  )
}

/* ─── Matrix dot loader ─────────────────────────────────────────────────── */

export type MatrixVariant = "scan" | "twinkle" | "orbit" | "pulse"

const TWINKLE_ORDER = [7, 2, 11, 5, 14, 9, 0, 12, 3, 15, 6, 10, 13, 1, 8, 4]
const ORBIT_RING = [1, 2, 7, 11, 14, 13, 8, 4]
const PULSE_INNER = [5, 6, 9, 10]
const ROUNDED_GAPS = [0, 3, 12, 15]

function matrixDelays(variant: MatrixVariant, cycle: number): number[] {
  const delays = new Array<number>(16).fill(0)
  switch (variant) {
    case "scan":
      for (let i = 0; i < 16; i++) delays[i] = (i % 4) * (cycle / 10)
      break
    case "twinkle":
      TWINKLE_ORDER.forEach((dot, order) => {
        delays[dot] = order * (cycle / 16)
      })
      break
    case "orbit":
      ORBIT_RING.forEach((dot, order) => {
        delays[dot] = order * (cycle / 8)
      })
      break
    case "pulse":
      for (let i = 0; i < 16; i++) delays[i] = PULSE_INNER.includes(i) ? 0 : cycle * 0.16
      break
  }
  return delays
}

/**
 * 4×4 dot matrix that pulses in a pattern. Inherits `currentColor`, so size and
 * tone come from the parent. `rounded` hides the corners so the grid reads as a
 * disc (orbit/pulse look best rounded).
 */
export function MatrixLoader({
  variant = "twinkle",
  rounded,
  cycle = 1200,
  dot = 2,
  gap = 2,
  className,
  label,
}: {
  variant?: MatrixVariant
  rounded?: boolean
  cycle?: number
  dot?: number
  gap?: number
  className?: string
  label?: string
}) {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (ref.current) return observeLoopVisibility(ref.current)
  }, [])
  const isRounded = rounded ?? (variant === "orbit" || variant === "pulse")
  const delays = useMemo(() => matrixDelays(variant, cycle), [variant, cycle])
  const style = { "--matrix-cycle": `${cycle}ms`, "--matrix-dot": `${dot}px`, "--matrix-gap": `${gap}px` } as CSSProperties
  return (
    <span ref={ref} className={cn("t-matrix", className)} style={style} role={label ? "status" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      {delays.map((d, i) => (
        <i key={i} className={isRounded && ROUNDED_GAPS.includes(i) ? "is-gap" : undefined} style={{ "--d": d } as CSSProperties} />
      ))}
    </span>
  )
}

/* ─── Streaming words ───────────────────────────────────────────────────── */

/**
 * Splits text into words wrapped in spans keyed by index. New words mount
 * through `@starting-style` (blur + fade); words already on screen keep their
 * key and are never re-animated, so a growing stream only ever animates its tail.
 * Words present on this instance's first render (a thread opened mid-stream,
 * a remounted block) render as plain text: only words appended afterwards get
 * a span. When `live` is false the text renders as one plain string.
 */
export function StreamWords({ text, live = true }: { text: string; live?: boolean }) {
  // Word count of the first live render, kept in state (set during render) so it survives
  // re-renders without reading a ref.
  const [settled, setSettled] = useState<number | null>(null)
  if (!live || !text) return <>{text}</>
  const tokens = text.split(/(\s+)/)
  const isWord = (token: string) => token.length > 0 && !/^\s+$/.test(token)
  let settledWords = settled
  if (settledWords === null) {
    settledWords = tokens.reduce((n, token) => n + (isWord(token) ? 1 : 0), 0)
    setSettled(settledWords)
  }
  let word = 0
  return (
    <>
      {tokens.map((token, i) => {
        if (token.length === 0) return null
        if (!isWord(token)) return token
        return word++ < settledWords ? (
          token
        ) : (
          <span key={i} className="t-stream-w">
            {token}
          </span>
        )
      })}
    </>
  )
}

/* ─── Text swap ─────────────────────────────────────────────────────────── */

/**
 * Swaps a short label in place: the old one rises out with a blur while the
 * new one rises in from below. Keyed on the text itself; identical text never
 * re-animates. The first paint renders without motion. `render` formats a
 * label (both the leaving and the shown one) without changing what it is keyed on.
 */
export function TextSwap({
  text,
  className,
  as: Tag = "span",
  shimmer = false,
  render = (value) => value,
}: {
  text: string
  className?: string
  as?: "span" | "div"
  shimmer?: boolean
  render?: (text: string) => ReactNode
}) {
  const [state, setState] = useState<{ shown: string; leaving: string | null }>({ shown: text, leaving: null })
  // A shimmering label pauses while offscreen, clipped or in a hidden window.
  const shimmerRef = useLoopVisibility<HTMLSpanElement>(shimmer)
  // Adjust state during render (not in an effect) so the swap starts on the
  // same frame the text changes.
  if (state.shown !== text) setState({ shown: text, leaving: state.shown })
  useEffect(() => {
    if (state.leaving === null) return
    const id = window.setTimeout(() => setState((s) => (s.leaving === null ? s : { ...s, leaving: null })), 220)
    return () => window.clearTimeout(id)
  }, [state.leaving, state.shown])
  return (
    <Tag className={cn("t-text-swap min-w-0 max-w-full", className)}>
      {state.leaving !== null && (
        <span key={`out:${state.leaving}`} data-swap="out" aria-hidden className="truncate">
          {render(state.leaving)}
        </span>
      )}
      <span key={`in:${state.shown}`} ref={shimmer ? shimmerRef : undefined} data-swap={state.leaving !== null ? "in" : undefined} className={cn("truncate", shimmer && "t-shimmer")} data-text={shimmer ? state.shown : undefined}>
        {render(state.shown)}
      </span>
    </Tag>
  )
}

/* ─── Icon swap ─────────────────────────────────────────────────────────── */

/**
 * Two icons share one slot during the cross-blur; the inactive icon unmounts after it exits.
 * `tempo="quick"` runs the swap in 150 ms (copy -> check, play -> pause, other glyph flips that
 * happen all day) instead of 250 ms.
 */
export function IconSwap({ active, a, b, className, tempo }: { active: IconSwapKey; a: ReactNode; b: ReactNode; className?: string; tempo?: "quick" }) {
  const [state, setState] = useState<IconSwapState>(() => ({ shown: active, leaving: null }))
  const next = advanceIconSwap(state, active)
  // Preserve both nodes across rapid reversals so their CSS transitions retarget
  // from the currently painted state instead of restarting.
  if (next !== state) setState(next)
  const settleMs = tempo === "quick" ? ICON_SWAP_QUICK_MS : ICON_SWAP_TRANSITION_MS
  useEffect(() => {
    if (state.leaving === null) return
    const shown = state.shown
    const id = window.setTimeout(() => setState((current) => settleIconSwap(current, shown)), settleMs)
    return () => window.clearTimeout(id)
  }, [state.leaving, state.shown, settleMs])
  const swapping = state.leaving !== null
  return (
    <span className={cn("t-icon-swap", className)} data-swapping={swapping ? "true" : undefined} data-tempo={tempo}>
      {(state.shown === "a" || state.leaving === "a") && <span key="a" data-active={state.shown === "a"} className="flex size-full items-center justify-center">{a}</span>}
      {(state.shown === "b" || state.leaving === "b") && <span key="b" data-active={state.shown === "b"} className="flex size-full items-center justify-center">{b}</span>}
    </span>
  )
}
