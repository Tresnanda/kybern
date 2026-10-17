import { isWindowVisible, onWindowVisibility } from '../native/visibility.ts'
import { revealBoundary } from './reveal.ts'
// The existing port's live-state brightness pulse follows native display time.
// Simple native glyph tint avoids React and layout work on every pulse frame.
// Reduce Motion holds the plain muted label.
import { useEffect, useReducer, useRef, useState, type ReactNode } from 'react'
import { smoothAdvance, type SmoothState } from '../../../desktop/src/lib/smoothStream.ts'
import type { StyleDesc } from '@gpuix/react'
import { useLoaderTime, easeInOut, NATIVE_PAINT_ANIMATIONS } from '../MatrixLoader.tsx'
import { Swap } from '../motion/kit.tsx'
import { REDUCED_MOTION, Label } from '../ui.tsx'
import { alpha, ROW_LINE } from './kit.tsx'
import { PACE_MS } from './store.ts'
import type { MarkdownStream } from '../native/markdown.ts'
import { useTheme } from '../ui.tsx'

export function Shimmer({ text, color, size = 14, lineHeight = ROW_LINE }: { text: string; color: string; size?: number; lineHeight?: number }) {
  // Pixel/idle controls pass, but repeated full-app GPU controls have not yet
  // met the running-thread gate. Keep native glyph replay explicitly opt-in.
  if (NATIVE_PAINT_ANIMATIONS && process.env.KYBERN_NATIVE_TEXT_PAINT === '1') return <Label color={color} size={size} lineHeight={lineHeight} truncate paintAnimation={REDUCED_MOTION ? undefined : {kind:'shimmer',cycleMs:1600}}>{text}</Label>
  return <SampledShimmer text={text} color={color} size={size} lineHeight={lineHeight} />
}
function SampledShimmer({ text, color, size, lineHeight }: { text: string; color: string; size: number; lineHeight: number }) {
  const time = useLoaderTime()
  const phase = (time % 1600) / 1600
  const intensity = NATIVE_PAINT_ANIMATIONS ? 1 + .6 * easeInOut(phase < .5 ? phase * 2 : 2 - phase * 2) : [1, 1, 1.18, 1.42, 1.6, 1.42, 1.18, 1][Math.floor(time / 200) % 8]!
  return (
    <Label color={alpha(color, intensity)} size={size} lineHeight={lineHeight} truncate>
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
  if (!live || complete || REDUCED_MOTION || !isWindowVisible()) {
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
  const shown = !live || complete || REDUCED_MOTION || !isWindowVisible() ? target.length : revealBoundary(target, l.state.shown)
  const behind = live && shown < target.length
  // Cleared by the next render, so a paced commit within PACE_MS cancels it.
  useEffect(() => {
    if (!behind || !isWindowVisible() || REDUCED_MOTION) return
    const id = setTimeout(tick, PACE_MS)
    return () => clearTimeout(id)
  })
  useEffect(() => {
    if (!live || REDUCED_MOTION) return
    return onWindowVisibility(() => tick())
  }, [live])
  return behind ? target.slice(0, shown) : target
}

// ---- the live answer: caret and fading words ----

const countWords = (text: string) => { let n = 0; for (const _ of text.matchAll(/\S+/g)) n++; return n }
/** `KYBERN_STREAM_EFFECTS=0` turns caret and fade off and `caret` keeps only the caret, for measuring their cost. */
const STREAM_EFFECTS = process.env.KYBERN_STREAM_EFFECTS !== '0'
const STREAM_FADE = STREAM_EFFECTS && process.env.KYBERN_STREAM_EFFECTS !== 'caret'

/**
 * `.chat-message-segment[data-live] > .chat-markdown > :last-child::after` (a 2px, .95em bar that
 * blinks on `steps(2)` over 1s) and `.t-stream-w` (each new word fades in over `--stream-fade`,
 * 350 ms smooth-out). The native Markdown draws both: this only reports when each word was born
 * and which half of the blink it is. Reduce Motion keeps a still caret and shows words at once.
 */
export function useStreamEffects(text: string, live: boolean): MarkdownStream | undefined {
  const t = useTheme()
  const seen = useRef<{ count: number; born: number[] } | null>(null)
  const [phase, setPhase] = useState(true)
  useEffect(() => {
    if (!live || REDUCED_MOTION || !STREAM_EFFECTS) return
    const id = setInterval(() => { if (isWindowVisible()) setPhase(value => !value) }, 500)
    return () => clearInterval(id)
  }, [live])
  if (!live || !STREAM_EFFECTS) { seen.current = null; return undefined }
  const count = countWords(text)
  // A row that mounts mid-stream starts at what has arrived: nothing fades in for it.
  const state = (seen.current ??= { count, born: [] })
  if (count < state.count) { state.count = count; state.born.length = 0 }
  else if (count > state.count) {
    const now = Date.now()
    for (let i = state.count; i < count; i++) state.born.push(now)
    state.count = count
    if (state.born.length > 24) state.born.splice(0, state.born.length - 24)
  }
  return { caret: true, caretColor: t.text, caretVisible: REDUCED_MOTION || phase, born: REDUCED_MOTION || !STREAM_FADE ? [] : [...state.born], fadeMs: 350 }
}
