// Small motion primitives on top of styles/motion.css: the matrix dot loader,
// per-word streaming reveal, text and icon swaps, and the sliding tab pill.
// Everything here is transform/opacity/filter only and honours
// prefers-reduced-motion through the stylesheet.

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react"

import { cn } from "@/lib/utils"

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
  const isRounded = rounded ?? (variant === "orbit" || variant === "pulse")
  const delays = useMemo(() => matrixDelays(variant, cycle), [variant, cycle])
  const style = { "--matrix-cycle": `${cycle}ms`, "--matrix-dot": `${dot}px`, "--matrix-gap": `${gap}px` } as CSSProperties
  return (
    <span className={cn("t-matrix", className)} style={style} role={label ? "status" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
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
 * When `live` is false the text renders as one plain string.
 */
export function StreamWords({ text, live = true }: { text: string; live?: boolean }) {
  if (!live || !text) return <>{text}</>
  const tokens = text.split(/(\s+)/)
  return (
    <>
      {tokens.map((token, i) =>
        token.length === 0 ? null : /^\s+$/.test(token) ? (
          token
        ) : (
          <span key={i} className="t-stream-w">
            {token}
          </span>
        ),
      )}
    </>
  )
}

/* ─── Text swap ─────────────────────────────────────────────────────────── */

/**
 * Swaps a short label in place: the old one rises out with a blur while the
 * new one rises in from below. Keyed on the text itself; identical text never
 * re-animates. The first paint renders without motion.
 */
export function TextSwap({ text, className, as: Tag = "span" }: { text: string; className?: string; as?: "span" | "div" }) {
  const [state, setState] = useState<{ shown: string; leaving: string | null }>({ shown: text, leaving: null })
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
          {state.leaving}
        </span>
      )}
      <span key={`in:${state.shown}`} data-swap={state.leaving !== null ? "in" : undefined} className="truncate">
        {state.shown}
      </span>
    </Tag>
  )
}

/* ─── Icon swap ─────────────────────────────────────────────────────────── */

/** Two icons in one slot; `active` picks which is visible. Both stay mounted so the cross-blur can run. */
export function IconSwap({ active, a, b, className }: { active: "a" | "b"; a: ReactNode; b: ReactNode; className?: string }) {
  return (
    <span className={cn("t-icon-swap", className)}>
      <span data-active={active === "a"} className="inline-flex">
        {a}
      </span>
      <span data-active={active === "b"} className="inline-flex">
        {b}
      </span>
    </span>
  )
}
