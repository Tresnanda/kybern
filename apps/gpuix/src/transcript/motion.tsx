// Live-state motion on the shared loader clock (`MatrixLoader.tsx`): the
// desktop's `.shimmer` / `.t-shimmer` sweep becomes a slow brightness pulse
// (GPUIX cannot clip a moving gradient to glyphs), stepping with the loaders
// that are already animating so it adds no frames of its own. Reduce Motion
// freezes the clock, leaving the plain muted label.
import { useEffect, useReducer, useRef, useState, type ReactNode } from 'react'
import { smoothAdvance, type SmoothState } from '../../../desktop/src/lib/smoothStream.ts'
import type { StyleDesc } from '@gpuix/react'
import { useLoaderStep } from '../MatrixLoader.tsx'
import { Swap } from '../motion/kit.tsx'
import { Label } from '../ui.tsx'
import { alpha, ROW_LINE } from './kit.tsx'
import { PACE_MS } from './store.ts'

/** Opacity multiplier over 8 steps (1.6s): rest, rise to near full ink, fall back. */
const PULSE = [1, 1, 1.18, 1.42, 1.6, 1.42, 1.18, 1]

export function Shimmer({ text, color, size = 14, lineHeight = ROW_LINE }: { text: string; color: string; size?: number; lineHeight?: number }) {
  const step = useLoaderStep()
  return (
    <Label color={alpha(color, PULSE[step % PULSE.length]!)} size={size} lineHeight={lineHeight} truncate>
      {text}
    </Label>
  )
}

// ---- one-shot transitions (native tweens, `../motion/kit.tsx`) ----

/** How recent content must be to play its entrance (desktop: `Date.now() - at < 3000`). */
export const FRESH_MS = 3000

/** Decided once on mount, like the desktop's `fresh`: only content that just
 *  arrived plays its entrance. History pages and rows already there when the
 *  thread opened are older than this and render plainly. */
export function useFresh(at: string | undefined): boolean {
  const [fresh] = useState(() => {
    if (!at) return false
    const age = Date.now() - new Date(at).getTime()
    return age >= -FRESH_MS && age < FRESH_MS
  })
  return fresh
}

/**
 * `IconSwap` / `TextSwap` for a state that flips after mount (spinner → brain,
 * "Thinking" → "Thought", copy → check). The first paint renders plainly
 * (desktop: "The first paint renders without motion"); only a change plays the
 * kit's `Swap`, one 250 ms burst.
 */
export function SwapOnChange({ active, children, style }: { active: string; children: ReactNode; style?: StyleDesc }) {
  const [first] = useState(active)
  const [changed, setChanged] = useState(false)
  if (!changed && active !== first) setChanged(true)
  if (!changed) return <div style={{ display: 'flex', position: 'relative', alignItems: 'center', justifyContent: 'center', ...style }}>{children}</div>
  return <Swap active={active} style={style}>{children}</Swap>
}

// ---- paced streaming reveal ----

/**
 * `useSmoothStream` (desktop `lib/hooks.ts` + `lib/smoothStream.ts`): reveal a
 * live segment through the desktop's jitter buffer so bursty deltas read as a
 * steady flow. GPUIX lays out the whole window per commit, so the reveal adds
 * no commits of its own while deltas arrive: it advances on the paced block
 * commits (`usePacedBlocks`, ≤ every PACE_MS) and schedules one PACE_MS tick
 * only when the stream pauses with text still buffered. Not live: the text.
 */
export function useSmoothText(target: string, live: boolean, complete: boolean): string {
  const [, tick] = useReducer((n: number) => n + 1, 0)
  const loop = useRef<{ live: boolean; state: SmoothState; at: number }>({ live: false, state: { shown: target.length, vel: 0 }, at: 0 })
  const l = loop.current
  const now = performance.now()
  if (!live) {
    l.live = false
    l.state = { shown: target.length, vel: 0 }
  } else {
    // A row that mounts mid-stream starts at the received prefix.
    if (!l.live) l.state = { shown: target.length, vel: 0 }
    else if (l.state.shown > target.length) l.state = { shown: 0, vel: 0 }
    else l.state = smoothAdvance(l.state, target.length, now - l.at, complete)
    l.live = true
    l.at = now
  }
  const shown = Math.min(target.length, Math.floor(l.state.shown))
  const behind = live && shown < target.length
  // Cleared by the next render, so a paced commit within PACE_MS cancels it.
  useEffect(() => {
    if (!behind) return
    const id = setTimeout(tick, PACE_MS)
    return () => clearTimeout(id)
  })
  return behind ? target.slice(0, shown) : target
}
