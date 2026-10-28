import { useLoopRunning, useLoopVisibility } from '../native/loop-visibility.ts'
import { useTranscriptEntranceLease, useTranscriptFirstMount } from './Window.tsx'
import { isWindowVisible, onWindowVisibility } from '../native/visibility.ts'
import { revealBoundary } from './reveal.ts'
// The existing port's live-state brightness pulse follows native display time.
// Simple native glyph tint avoids React and layout work on every pulse frame.
// Reduce Motion holds the plain muted label.
import { useEffect, useReducer, useRef, useState } from 'react'
import { smoothAdvance, type SmoothState } from '../shared/lib/smoothStream.ts'
import type { StyleDesc } from '@gpuix/react'
import { useLoaderTime, easeInOut, NATIVE_PAINT_ANIMATIONS, NATIVE_TEXT_PAINT } from '../MatrixLoader.tsx'
import { REDUCED_MOTION, Label } from '../ui.tsx'
import { alpha, ROW_LINE } from './kit.tsx'
import { PACE_MS } from './store.ts'
import type { MarkdownStream } from '../native/markdown.ts'
import { useTheme } from '../ui.tsx'

export function Shimmer({ text, color, size = 14, lineHeight = ROW_LINE }: { text: string; color: string; size?: number; lineHeight?: number }) {
  return NATIVE_TEXT_PAINT
    ? <NativeShimmer text={text} color={color} size={size} lineHeight={lineHeight} />
    : <SampledShimmer text={text} color={color} size={size} lineHeight={lineHeight} />
}
/** `.t-shimmer`: the label stays in `color` while a soft band of the foreground colour sweeps across it, left to right, every
 *  2 s (linear), glyph by glyph, natively (`highlight`; Core Animation once it settles). */
function NativeShimmer({text,color,size,lineHeight}: {text:string;color:string;size:number;lineHeight:number}) {
  const t = useTheme()
  const loop = useLoopRunning(!REDUCED_MOTION)
  return <Label ref={loop.ref} color={color} size={size} lineHeight={lineHeight} truncate paintAnimation={loop.running ? {kind:'shimmer',cycleMs:SHIMMER_MS,highlight:t.text} : undefined}>{text}</Label>
}
/** `--shimmer-dur`. */
const SHIMMER_MS = 2000

function SampledShimmer({ text, color, size, lineHeight }: { text: string; color: string; size: number; lineHeight: number }) {
  const loop = useLoopVisibility(!REDUCED_MOTION)
  const time = useLoaderTime(loop.visible)
  const phase = (time % 1600) / 1600
  const intensity = NATIVE_PAINT_ANIMATIONS ? 1 + .6 * easeInOut(phase < .5 ? phase * 2 : 2 - phase * 2) : [1, 1, 1.18, 1.42, 1.6, 1.42, 1.18, 1][Math.floor(time / 200) % 8]!
  return (
    <Label ref={loop.ref} color={alpha(color, intensity)} size={size} lineHeight={lineHeight} truncate>
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
  const firstMount = useTranscriptFirstMount()
  const [fresh] = useState(() => {
    if (!at || !firstMount) return false
    const age = Date.now() - new Date(at).getTime()
    return age >= -FRESH_MS && age < FRESH_MS
  })
  useTranscriptEntranceLease(fresh ? FRESH_MS : 0)
  return fresh
}

// `IconSwap` / `TextSwap` for a state that flips after mount (spinner → brain, "Thinking" → "Thought", copy → check). The first
// paint renders plainly (desktop: "The first paint renders without motion"); every change after it cross-swaps and keeps the
// outgoing state for its exit. Pass `kind="icon"` for glyphs.
export { SwapOnChange } from '../motion/kit.tsx'

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
export function useStreamEffects(text: string, live: boolean, visible = true): MarkdownStream | undefined {
  const t = useTheme()
  const seen = useRef<{ count: number; born: number[] } | null>(null)
  const [phase, setPhase] = useState(true)
  useEffect(() => {
    if (!live || !visible || REDUCED_MOTION || !STREAM_EFFECTS) return
    let timer: ReturnType<typeof setInterval> | undefined
    const sync = () => {
      if (timer) clearInterval(timer)
      timer = undefined
      if (isWindowVisible()) timer = setInterval(() => setPhase(value => !value), 500)
    }
    const stop = onWindowVisibility(sync)
    sync()
    return () => { stop(); clearInterval(timer) }
  }, [live, visible])
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
