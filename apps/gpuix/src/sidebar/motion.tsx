// Thread panel motion (`views/Sidebar.tsx`, `lib/kit/disclosureMotion.ts`,
// `styles/motion.css` `.t-reveal`, `styles/subagents.css` `.sa-side-row`) on the
// kit's tokens. Every piece is a short native tween: nothing runs per frame in JS
// and nothing loops.
//
// The list is one flat `<virtual-list>`, so a disclosure cannot animate a nested
// region the way the desktop's grid shell does. Instead the rows a toggle adds or
// removes travel together as one list item for the 220 ms of the tween
// (`DisclosureGroup`), then flatten back into ordinary virtual rows.
import { motion } from '@gpuix/react'
import { useState, type ReactNode } from 'react'
import { DISCLOSURE, DISTANCE, DURATION, EASE } from '../motion/kit.tsx'
import { REDUCED_MOTION } from '../ui.tsx'
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

/**
 * `.t-reveal`: hover-revealed row actions fade in and slide 4px from the right
 * over `--duration-quick` ease-out. They hide at once when the pointer leaves:
 * GPUIX cannot keep the leaving copy stacked over the returning glyph.
 */
export function Reveal({ children, slide = true }: { children: ReactNode; slide?: boolean }) {
  return (
    <motion.div
      initial={{ opacity: 0, left: slide && !REDUCED_MOTION ? DISTANCE.micro : 0 }}
      animate={{ opacity: 1, left: 0 }}
      transition={tween(DURATION.quick, EASE.out)}
      style={{ display: 'flex', alignItems: 'center', position: 'relative' }}
    >
      {children}
    </motion.div>
  )
}

/**
 * The resting glyph coming back after a hover (`HOVER_HIDE_THREAD`'s
 * `transition-opacity`, 150 ms). `play={false}` on the row's first paint.
 */
export function FadeBack({ children, play, style, testId }: { children: ReactNode; play: boolean; style?: object; testId?: string }) {
  if (!play) return <div testId={testId} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', ...style }}>{children}</div>
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={tween(DURATION.quick, EASE.out)}
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', ...style }}
    >
      {children}
    </motion.div>
  )
}

/**
 * `TextSwap` on a row title: a new title (a rename, the agent's first title)
 * fades up 4px over 250 ms smooth-out. The first paint shows it plainly.
 */
export function TitleSwap({ text, children }: { text: string; children: ReactNode }) {
  const [shown, setShown] = useState({ text, play: false })
  if (shown.text !== text) setShown({ text, play: true })
  return (
    <motion.div
      key={text}
      initial={shown.play ? { opacity: 0, top: REDUCED_MOTION ? 0 : DISTANCE.micro } : false}
      animate={{ opacity: 1, top: 0 }}
      transition={tween(DURATION.fast, EASE.smoothOut)}
      style={{ display: 'flex', position: 'relative', flexGrow: 1, minWidth: 0 }}
    >
      {children}
    </motion.div>
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
