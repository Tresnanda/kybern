// Thread panel motion (`views/Sidebar.tsx`, `lib/kit/disclosureMotion.ts`,
// `styles/motion.css` `.t-reveal`, `styles/subagents.css` `.sa-side-row`) on the
// kit's tokens. Every piece is a short native tween: nothing runs per frame in JS
// and nothing loops.
//
// The list is one flat `<virtual-list>`, so a disclosure cannot animate a nested
// region the way the desktop's grid shell does. Instead the rows a toggle adds or
// removes travel together as one list item for the 220 ms of the tween
// (`DisclosureGroup`), then flatten back into ordinary virtual rows.
import { motion, useGpuix, type PublicInstance, type StyleDesc } from '@gpuix/react'
import type { PaintTransformProps } from '@gpuix/native/host'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { DISCLOSURE, DISTANCE, DURATION, EASE, SwapOnChange } from '../motion/kit.tsx'
import { EXIT, Presence } from '../motion/Presence.tsx'
import { Label, REDUCED_MOTION } from '../ui.tsx'
import type { Row } from './model.ts'

const tween = (duration: number, ease: readonly [number, number, number, number]) => ({ duration, ease: [...ease] as [number, number, number, number] })

/** Each row's height in the list, padding included (rows.tsx). Null: not known. */
export function rowHeight(row: Row): number | null {
  switch (row.kind) {
    case 'thread':
    case 'create-coordinator':
    case 'more':
    case 'no-threads':
      return 30
    case 'child':
      return 32
    case 'project':
      return row.first ? 28 : 40
    case 'recents':
      return 40
    case 'label':
      return 42
    case 'message':
      return null
  }
}

/**
 * Rows a disclosure adds or removes, as one block: the height runs 0 ↔ the
 * rows' total and the block fades, while the rows drift 4px down into place
 * (`disclosureShellClassName` + `disclosureContentClassName`: 220 ms ease-out).
 */
export function DisclosureGroup({ mode, height, onDone, children }: { mode: 'open' | 'close'; height: number; onDone: () => void; children: ReactNode }) {
  const opening = mode === 'open'
  const drift = -DISTANCE.micro
  return (
    <motion.div
      initial={{ height: opening ? 0 : height, opacity: opening ? 0 : 1 }}
      animate={{ height: opening ? height : 0, opacity: opening ? 1 : 0 }}
      transition={tween(DISCLOSURE, EASE.out)}
      onMotionComplete={onDone}
      style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', flexShrink: 0 }}
    >
      <motion.div
        initial={{ top: opening ? drift : 0 }}
        animate={{ top: opening ? 0 : drift }}
        transition={tween(DISCLOSURE, EASE.out)}
        style={{ display: 'flex', flexDirection: 'column', position: 'relative', flexShrink: 0 }}
      >
        {children}
      </motion.div>
    </motion.div>
  )
}

/** `t-reveal` in: opacity 0 → 1 and a 4px slide in from the right over 150 ms ease-out (opacity only under Reduce Motion). */
function revealEnter(slide: boolean): PaintTransformProps | undefined {
  if (!PATCHED_NATIVE) return undefined
  const ease = [...EASE.out] as [number, number, number, number]
  if (REDUCED_MOTION || !slide) return { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: DURATION.quick, ease } }
  return { initial: { opacity: 0, translateX: DISTANCE.micro }, animate: { opacity: 1, translateX: 0 }, transition: { duration: DURATION.quick, ease } }
}

/**
 * `.t-reveal`: hover-revealed row actions fade in and slide 4px from the right over `--duration-quick` ease-out, and fade out over
 * 100 ms when the pointer leaves (`Presence` keeps them mounted, non-interactive, for the exit while the resting glyph fades back
 * in over them). `show` is the row's hover; the controls stay mounted for the row's life, so a row's hover never remounts them.
 * `still` mounts them already shown without the entrance (an active filter pins its toolbar on screen). Paint-only: no layout or
 * render per frame.
 */
export function Reveal({ show, children, slide = true, still = false }: { show: boolean; children: ReactNode; slide?: boolean; still?: boolean }) {
  return (
    <Presence show={show} enter={still ? undefined : revealEnter(slide)} exit={EXIT.reveal} style={{ flexDirection: 'row', alignItems: 'center', position: 'relative' }}>
      {children}
    </Presence>
  )
}

/**
 * The resting glyph coming back after a hover (`HOVER_HIDE_THREAD`'s `transition-opacity`, 150 ms). `play={false}` on the row's
 * first paint. Paint-only.
 */
export function FadeBack({ children, play, style, testId }: { children: ReactNode; play: boolean; style?: StyleDesc; testId?: string }) {
  const base = { display: 'flex', alignItems: 'center', justifyContent: 'center', ...style } as const
  if (!play || !PATCHED_NATIVE) return <div testId={testId} style={base}>{children}</div>
  return (
    <div
      testId={testId}
      paintTransform={{ initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: DURATION.quick, ease: [...EASE.out] } }}
      style={base}
    >
      {children}
    </div>
  )
}

/**
 * `TextSwap` on a row title: a new title (a rename, the agent's first title) rises in from 4px below with a 2px blur over 250 ms
 * smooth-out while the old one leaves up and out over 150 ms. The first paint shows it plainly.
 */
export function TitleSwap({ text, children }: { text: string; children: ReactNode }) {
  return (
    <SwapOnChange
      active={text}
      style={{ flexGrow: 1, minWidth: 0, justifyContent: 'flex-start', alignItems: 'center', pointerEvents: 'none', userSelect: 'none' }}
      innerStyle={{ flexGrow: 1, minWidth: 0, justifyContent: 'flex-start' }}
      leavingStyle={{ right: 0 }}
    >
      {children}
    </SwapOnChange>
  )
}

/** `lib/kit/marquee.ts`: pixels per second the label travels and the shortest pan. */
const MARQUEE_SPEED = 28
const MARQUEE_MIN_MS = 900
/** `.t-marquee` hover: the pan starts 350 ms after the pointer arrives (`transform … linear 350ms`). */
const MARQUEE_DELAY_MS = 350
/** The row's trailing padding settles in 150 ms; `primeMarquee` measures again at 180 ms, inside the delay. */
const MARQUEE_MEASURE_MS = 190
/** `transform var(--duration-slow) var(--ease-out)`: the pan back. */
const MARQUEE_BACK = 0.4

/**
 * `.t-marquee` + `primeMarquee` (`lib/kit/marquee.ts`, `styles/motion.css`): a truncated row title pans to show its tail
 * while the row is hovered (after 350 ms, at a steady 28 px/s, at least 900 ms), then pans back over 400 ms.
 * At rest it is the plain ellipsised label. Hovered, the ellipsis goes at once and the text is clipped at the label's edge
 * (CSS: `text-overflow: clip`), then the pan runs as one native `left` tween: no JS runs per frame. Titles that fit never
 * move. Reduce Motion: no transition, the tail is shown immediately (`.t-marquee > span { transition: none }`).
 */
export function MarqueeLabel({ hover, text, color, lineHeight = 20 }: { hover: boolean; text: string; color: string; lineHeight?: number }) {
  const { renderer } = useGpuix()
  const box = useRef<PublicInstance | null>(null)
  const inner = useRef<PublicInstance | null>(null)
  const [overflow, setOverflow] = useState(0)
  // 'rest': the ellipsised label. 'live': hovered. 'back': panning home, then the ellipsis returns.
  const [phase, setPhase] = useState<'rest' | 'live' | 'back'>('rest')
  if (hover && phase !== 'live') setPhase('live')
  useEffect(() => {
    if (!hover) return
    const timer = setTimeout(() => {
      const w = box.current ? renderer?.getElementBounds?.(box.current.id)?.width : undefined
      const t = inner.current ? renderer?.getElementBounds?.(inner.current.id)?.width : undefined
      if (w == null || t == null) return
      const hidden = Math.max(0, t - w)
      setOverflow(hidden > 0.5 ? hidden : 0)
    }, REDUCED_MOTION ? 16 : MARQUEE_MEASURE_MS)
    return () => clearTimeout(timer)
  }, [hover, text, renderer])
  useEffect(() => {
    if (hover || phase !== 'live') return
    // Nothing panned (the title fits, or the pointer left before the pan): the ellipsis returns at once.
    if (overflow === 0 || REDUCED_MOTION) {
      setPhase('rest')
      setOverflow(0)
      return
    }
    setPhase('back')
    const timer = setTimeout(() => {
      setPhase('rest')
      setOverflow(0)
    }, MARQUEE_BACK * 1000 + 40)
    return () => clearTimeout(timer)
  }, [hover, phase, overflow])
  if (phase === 'rest') {
    return (
      <Label color={color} lineHeight={lineHeight} truncate style={{ flexGrow: 1, pointerEvents: 'none', userSelect: 'none' }}>
        {text}
      </Label>
    )
  }
  const panning = hover && overflow > 0
  const duration = Math.max(MARQUEE_MIN_MS, Math.round((overflow / MARQUEE_SPEED) * 1000)) / 1000
  return (
    <div ref={box} style={{ display: 'flex', flexGrow: 1, minWidth: 0, height: lineHeight, overflow: 'hidden', pointerEvents: 'none', userSelect: 'none' }}>
      <motion.div
        initial={false}
        animate={{ left: panning ? -overflow : 0 }}
        transition={panning ? (REDUCED_MOTION ? { duration: 0 } : { duration, ease: [0, 0, 1, 1], delay: (MARQUEE_DELAY_MS - MARQUEE_MEASURE_MS) / 1000 }) : { duration: REDUCED_MOTION ? 0 : MARQUEE_BACK, ease: [...EASE.out] as [number, number, number, number] }}
        style={{ display: 'flex', position: 'relative', flexShrink: 0 }}
      >
        <div ref={inner} style={{ display: 'flex', flexShrink: 0 }}>
          <Label color={color} lineHeight={lineHeight} style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>
            {text}
          </Label>
        </div>
      </motion.div>
    </div>
  )
}

/** `transition-[padding] duration-150 ease-out`: room for the revealed actions opens smoothly. */
export function PadTween({ width, cancelGap = 0 }: { width: number; /** The parent's flex gap, cancelled so 0 adds nothing. */ cancelGap?: number }) {
  return <motion.div initial={false} animate={{ width }} transition={tween(DURATION.quick, EASE.out)} style={{ flexShrink: 0, height: 1, marginLeft: -cancelGap }} />
}

/**
 * `.sa-side-row[data-leaving]`: a finished subagent row rises 4px, fades and
 * collapses over 200 ms ease-out, then `onDone` removes it. Reduce Motion:
 * a 120 ms fade only.
 */
export function Leave({ height, onDone, children }: { height: number; onDone: () => void; children: ReactNode }) {
  if (REDUCED_MOTION)
    return (
      <motion.div initial={{ opacity: 1 }} animate={{ opacity: 0 }} transition={tween(0.12, EASE.out)} onMotionComplete={onDone} style={{ display: 'flex', flexDirection: 'column' }}>
        {children}
      </motion.div>
    )
  return (
    <motion.div
      initial={{ height, opacity: 1 }}
      animate={{ height: 0, opacity: 0 }}
      transition={tween(0.2, EASE.out)}
      onMotionComplete={onDone}
      style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', flexShrink: 0 }}
    >
      <motion.div
        initial={{ top: 0 }}
        animate={{ top: -DISTANCE.micro }}
        transition={tween(0.2, EASE.out)}
        style={{ display: 'flex', flexDirection: 'column', position: 'relative', flexShrink: 0 }}
      >
        {children}
      </motion.div>
    </motion.div>
  )
}

// ---- which rows a list change animates ----

/** Set by a disclosure toggle; the next list change it causes animates as a group. */
let disclosureAt = -Infinity
export function markDisclosure() {
  disclosureAt = performance.now()
}
function takeDisclosure(): boolean {
  const recent = performance.now() - disclosureAt < 500
  disclosureAt = -Infinity
  return recent
}

export interface Group {
  id: number
  mode: 'open' | 'close'
  /** Opening: the keys of the rows that came in. */
  keys: string[]
  /** Closing: the rows that left, kept for their exit, and the row they followed. */
  rows: Row[]
  after: string | null
  height: number
}

let nextGroup = 0
const FRESH_MS = 3000

/** A thread row for a thread created or touched just now (`fresh` in `ThreadRow`). */
function isFresh(row: Row, now: number) {
  if (row.kind === 'thread') return now - Date.parse(row.thread.updated_at) < FRESH_MS
  if (row.kind === 'child') {
    const started = (row.thread.subagent ?? row.thread.delegation)?.started_at
    return !!started && now - Date.parse(started) < FRESH_MS
  }
  return false
}

/**
 * Compare two lists. After a disclosure toggle, each run of added or removed
 * rows becomes a group. Otherwise rows that appear for fresh threads rise in
 * (`t-row-enter`); nothing else animates.
 */
export function diffRows(prev: readonly Row[], next: readonly Row[]): { groups: Group[]; risen: string[] } {
  const prevKeys = new Set(prev.map((r) => r.key))
  const nextKeys = new Set(next.map((r) => r.key))
  const disclosure = takeDisclosure()
  if (REDUCED_MOTION && disclosure) return { groups: [], risen: [] }
  if (!disclosure) {
    if (REDUCED_MOTION) return { groups: [], risen: [] }
    const now = Date.now()
    return { groups: [], risen: next.filter((r) => !prevKeys.has(r.key) && isFresh(r, now)).map((r) => r.key) }
  }
  const groups: Group[] = []
  const total = (rows: Row[]) => {
    let sum = 0
    for (const row of rows) {
      const h = rowHeight(row)
      if (h === null) return null
      sum += h
    }
    return sum
  }
  for (let i = 0; i < next.length; ) {
    if (prevKeys.has(next[i]!.key)) {
      i++
      continue
    }
    const run: Row[] = []
    while (i < next.length && !prevKeys.has(next[i]!.key)) run.push(next[i++]!)
    const height = total(run)
    if (height) groups.push({ id: ++nextGroup, mode: 'open', keys: run.map((r) => r.key), rows: [], after: null, height })
  }
  for (let i = 0; i < prev.length; ) {
    if (nextKeys.has(prev[i]!.key)) {
      i++
      continue
    }
    const after = i > 0 ? prev[i - 1]!.key : null
    const run: Row[] = []
    while (i < prev.length && !nextKeys.has(prev[i]!.key)) run.push(prev[i++]!)
    const height = total(run)
    if (height) groups.push({ id: ++nextGroup, mode: 'close', keys: run.map((r) => r.key), rows: run, after, height })
  }
  return { groups, risen: [] }
}

/** Groups still worth showing once the list is `next`: a reversed toggle drops the old one. */
export function liveGroups(groups: readonly Group[], next: readonly Row[]): Group[] {
  const keys = new Set(next.map((r) => r.key))
  return groups.filter((g) =>
    g.mode === 'open' ? g.keys.every((k) => keys.has(k)) : g.keys.every((k) => !keys.has(k)) && (g.after === null || keys.has(g.after)),
  )
}

/** The list to render: rows, with each animating group standing in for its rows as one item. */
export type Item = { kind: 'row'; row: Row } | { kind: 'group'; group: Group; rows: Row[] }

export function withGroups(rows: readonly Row[], groups: readonly Group[]): Item[] {
  if (groups.length === 0) return rows.map((row) => ({ kind: 'row', row }))
  const opening = new Map<string, Group>()
  for (const g of groups) if (g.mode === 'open') for (const k of g.keys) opening.set(k, g)
  const closing = new Map<string | null, Group[]>()
  for (const g of groups) if (g.mode === 'close') closing.set(g.after, [...(closing.get(g.after) ?? []), g])
  const items: Item[] = []
  const placed = new Set<Group>()
  const pushClosing = (key: string | null) => {
    for (const g of closing.get(key) ?? []) items.push({ kind: 'group', group: g, rows: g.rows })
  }
  pushClosing(null)
  for (const row of rows) {
    const g = opening.get(row.key)
    if (g) {
      if (!placed.has(g)) {
        placed.add(g)
        items.push({ kind: 'group', group: g, rows: rows.filter((r) => opening.get(r.key) === g) })
      }
    } else items.push({ kind: 'row', row })
    pushClosing(row.key)
  }
  return items
}
