// Tree connectors, painted (`geometry.ts` has the shapes). Every piece is a passive absolutely positioned hairline,
// so a settled tree is plain quads: no islands, observers or timers, nothing per scroll frame.
//
// Motion is paint-only (`paintTransform`, tier 1 in `../motion/README.md`) and fresh-only:
// - Opening a group: the parent's stem draws down from under its icon, then each child's slice of the stem draws
//   down, its tick runs out to the icon and the row rises in, 24 ms apart (the fourth child on share one delay), all
//   within 250 ms. Closing reverses it from the last child, faster.
// - A child arriving in an open group draws its slice and elbow; the old last child's elbow turns into a tee whose
//   stem runs on down to it, so the elbow travels to the new last row.
// - Rows remounted by a virtual list, or a group shown already open, paint at rest.
// Reduce Motion: a 150 ms fade, no drawing, no stagger.
import type { PaintTransformProps, PaintTransformValue } from '@gpuix/native/host'
import { createContext, memo, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { BLUR, DISTANCE, DURATION, EASE } from '../motion/kit.tsx'
import { ink, REDUCED_MOTION, useTheme } from '../ui.tsx'
import type { Theme } from '../theme.ts'
import { HAIRLINE, treeSegments, type Joint, type Segment, type TreeShape } from './geometry.ts'

export { flatTree, ELBOW, HAIRLINE, TICK_GAP, type Joint, type TreeShape } from './geometry.ts'

/** Seconds. Children start after the parent's stem has drawn (`lead`); each slice, tick and row overlap. */
export const TREE_MOTION = {
  lead: 0.04,
  step: 0.024,
  /** Children from this index share the last delay, so a long group still finishes inside 250 ms. */
  cap: 3,
  slice: 0.07,
  tick: 0.07,
  tickDelay: 0.045,
  row: 0.12,
  rowDelay: 0.01,
  /** Closing: faster, from the last child up. */
  leaveStep: 0.016,
  leave: 0.05,
  rowLeave: 0.09,
} as const

/** The connector colour: a quiet hairline a little stronger than `--color-border`, since it is one device pixel wide. */
export function treeLine(t: Theme): string {
  return t.contrast ? ink(t, 0.42) : ink(t, t.variant === 'dark' ? 0.2 : 0.22)
}

/** A row's place in a group that is opening (`enter`) or closing (`leave`) right now. */
export interface TreeMotionState {
  mode: 'enter' | 'leave'
  index: number
  count: number
  /** Px the row rises from (positive: from below). 0: the row only fades (its container already moves). */
  rise?: number
  /** Seconds before the first child starts (the parent's own stem drawing first). */
  lead?: number
}
export const TreeMotion = createContext<TreeMotionState | null>(null)

const bezier = (ease: readonly [number, number, number, number]) => [...ease] as [number, number, number, number]
const ORIGIN: Record<Segment['draw'], [number, number]> = { down: [0.5, 0], right: [0, 0.5], corner: [0, 0], none: [0.5, 0.5] }
// A stem grows along its length only, a tick along its width (one-axis scale, native N5); the elbow scales from its corner.
const HIDDEN: Record<Segment['draw'], PaintTransformValue> = {
  down: { scaleY: 0.02, opacity: 0 },
  right: { scaleX: 0.02, opacity: 0 },
  corner: { scale: 0.02, opacity: 0 },
  none: { opacity: 0 },
}
const REST: Record<Segment['draw'], PaintTransformValue> = {
  down: { scaleY: 1, opacity: 1 },
  right: { scaleX: 1, opacity: 1 },
  corner: { scale: 1, opacity: 1 },
  none: { opacity: 1 },
}
/** Opacity reaches full a quarter of the way in, so the line reads as drawing rather than fading. */
const DRAW_KEYS = [{ offset: 0.25, opacity: 1 }]

let generation = 6_000_000

/** When a segment starts drawing in or out, relative to its row's start. */
function segmentDelay(segment: Segment, leaving: boolean) {
  const m = TREE_MOTION
  if (leaving) return segment.draw === 'right' || segment.draw === 'corner' ? 0 : m.leave * 0.6
  if (segment.key === 'tee') return m.slice * 0.6
  if (segment.draw === 'right' || segment.draw === 'corner') return m.tickDelay
  return 0
}

function rowStart(motion: TreeMotionState) {
  const m = TREE_MOTION
  if (motion.mode === 'leave') return Math.min(motion.count - 1 - motion.index, m.cap) * m.leaveStep
  return (motion.lead ?? m.lead) + Math.min(motion.index, m.cap) * m.step
}

function drawTransform(segment: Segment, kind: 'in' | 'out' | 'rest', start: number, gen: number, change = false): PaintTransformProps | undefined {
  if (!PATCHED_NATIVE) return undefined
  if (kind === 'rest') return { initial: false, animate: REST[segment.draw], transition: { duration: DURATION.quick, ease: bezier(EASE.out) }, origin: ORIGIN[segment.draw], generation: gen }
  if (REDUCED_MOTION) {
    return kind === 'in'
      ? { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: DURATION.quick, ease: bezier(EASE.out) }, generation: gen }
      : { initial: false, animate: { opacity: 0 }, transition: { duration: 0.1, ease: bezier(EASE.out) }, generation: gen }
  }
  const m = TREE_MOTION
  // A piece added to a settled row (the old last child's tee) starts at once: the elbow it replaces is already gone.
  const delay = start + (change && segment.key === 'tee' ? 0 : segmentDelay(segment, kind === 'out'))
  return kind === 'in'
    ? { initial: HIDDEN[segment.draw], animate: REST[segment.draw], keyframes: DRAW_KEYS, transition: { duration: segment.draw === 'down' ? m.slice : m.tick, delay, ease: bezier(EASE.out) }, origin: ORIGIN[segment.draw], generation: gen }
    : { initial: false, animate: HIDDEN[segment.draw], transition: { duration: m.leave, delay, ease: bezier(EASE.out) }, origin: ORIGIN[segment.draw], generation: gen }
}

/**
 * The connector pieces of one row, inside its `position: relative` box (they paint over the row's hover and selection
 * fills, so render them after the row's content). Hit testing ignores them.
 */
export const TreeLines = memo(function TreeLines({ shape, motion: own }: { shape: TreeShape; /** Overrides `TreeMotion` (a row drawing its own slot). */ motion?: TreeMotionState | null }) {
  const t = useTheme()
  const color = treeLine(t)
  const context = useContext(TreeMotion)
  const motion = own === undefined ? context : own
  const segments = useMemo(() => treeSegments(shape), [shape])
  // Pieces present at mount enter only when the row's group is opening; pieces that appear later (a child arrived
  // below, the row gained children) draw in. Once animated, a piece keeps its transform at rest.
  const life = useRef<{ mounted: Set<string> | null; animated: Map<string, number>; leaving: boolean }>({ mounted: null, animated: new Map(), leaving: false })
  const l = life.current
  const first = l.mounted === null
  if (first) l.mounted = new Set(segments.map(s => s.key))
  const leaving = motion?.mode === 'leave'
  const start = motion ? rowStart(motion) : 0
  const transforms = new Map<string, PaintTransformProps | undefined>()
  for (const segment of segments) {
    let transform: PaintTransformProps | undefined
    if (segment.draw === 'none') transform = undefined
    else if (leaving) {
      if (!l.leaving || !l.animated.has(segment.key)) l.animated.set(segment.key, ++generation)
      transform = drawTransform(segment, 'out', start, l.animated.get(segment.key)!)
    } else if (l.leaving && l.animated.has(segment.key)) {
      // Reopened while closing: back to rest from wherever it is.
      l.animated.set(segment.key, ++generation)
      transform = drawTransform(segment, 'rest', 0, l.animated.get(segment.key)!)
    } else if (l.animated.has(segment.key)) {
      transform = drawTransform(segment, l.leaving ? 'rest' : 'in', start, l.animated.get(segment.key)!)
    } else if ((first && motion?.mode === 'enter') || (!first && !l.mounted!.has(segment.key))) {
      l.animated.set(segment.key, ++generation)
      // A piece added after mount (the old last row's tee) draws as soon as it appears; the arriving row follows.
      transform = drawTransform(segment, 'in', first ? start : 0, l.animated.get(segment.key)!, !first)
    }
    transforms.set(segment.key, transform)
  }
  l.leaving = leaving
  for (const segment of segments) l.mounted!.add(segment.key)
  return (
    <>
      {segments.map(segment => (
        <div
          key={segment.key}
          paintTransform={transforms.get(segment.key)}
          style={{
            position: 'absolute',
            left: segment.left,
            top: segment.top,
            width: segment.width,
            ...(segment.height !== undefined ? { height: segment.height } : { bottom: segment.bottom ?? 0 }),
            ...(segment.corner
              ? { borderLeftWidth: HAIRLINE, borderBottomWidth: HAIRLINE, borderColor: color, borderBottomLeftRadius: segment.corner }
              : { backgroundColor: color }),
            pointerEvents: 'none',
          }}
        />
      ))}
    </>
  )
})

function riseTransform(motion: TreeMotionState | null, fresh: boolean, gen: number): PaintTransformProps | undefined {
  if (!PATCHED_NATIVE || !motion) return undefined
  const m = TREE_MOTION
  const start = rowStart(motion)
  if (motion.mode === 'leave') {
    return REDUCED_MOTION
      ? { initial: false, animate: { opacity: 0 }, transition: { duration: 0.1, ease: bezier(EASE.out) }, generation: gen }
      : { initial: false, animate: { opacity: 0, translateY: -2 }, transition: { duration: m.rowLeave, delay: start, ease: bezier(EASE.out) }, generation: gen }
  }
  if (!fresh) return undefined
  if (REDUCED_MOTION) return { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: DURATION.quick, ease: bezier(EASE.out) }, generation: gen }
  const rise = motion.rise ?? DISTANCE.micro
  const initial: PaintTransformValue = rise ? { opacity: 0, translateY: rise, blur: BLUR.small } : { opacity: 0 }
  return { initial, animate: rise ? { opacity: 1, translateY: 0, blur: 0 } : { opacity: 1 }, transition: { duration: m.row, delay: start + m.rowDelay, ease: bezier(EASE.smoothOut) }, generation: gen }
}

/** The `paintTransform` of a row's root rising in (or fading out) with its group's stagger; undefined at rest. */
function useRise(motion: TreeMotionState | null): PaintTransformProps | undefined {
  const [fresh] = useState(() => motion?.mode === 'enter')
  const gen = useMemo(() => ++generation, [motion?.mode])
  // Once it has moved, it keeps a transform: back at rest after a reopen rather than dropping it mid-tween.
  const moved = useRef(false)
  let transform = riseTransform(motion, fresh, gen)
  if (transform) moved.current = true
  else if (moved.current && PATCHED_NATIVE) transform = { initial: false, animate: { opacity: 1, translateY: 0, blur: 0 }, transition: { duration: DURATION.quick, ease: bezier(EASE.out) }, generation: gen }
  return transform
}

/** A row's content rising in (or fading out) with its group's stagger. Outside an opening or closing group it is a plain box. */
export function TreeRise({ children }: { children: ReactNode }) {
  const transform = useRise(useContext(TreeMotion))
  return <div paintTransform={transform} style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>{children}</div>
}

// ---- nested lists (the transcript's groups) ----

interface GroupState {
  /** The stem's x and where ticks end, in the items' coordinates. */
  x: number
  tickEnd: number
  /** Space above the first item inside the group (its slice reaches up over it) and between items (a flex gap). */
  inset: number
  gap: number
  mode: 'enter' | 'leave' | null
  mountedAt: number
  rise?: number
}
const Group = createContext<GroupState | null>(null)

let openedAt = -Infinity
/** Call from the click that opens a group (before its state changes): the group that mounts next draws in. */
export function markTreeOpen() {
  openedAt = performance.now()
}
const OPEN_WINDOW_MS = 250
/** A new last child waits for the old last child's tee to draw down to it. */
export const ARRIVAL_LEAD = 0.05

/**
 * Children of a parent row, hung from one stem at `x` (the parent icon's centre, relative to the items' left edge).
 * Pass `open` when the group stays mounted while its container collapses, so its rows draw out in reverse.
 */
export function TreeGroup({ x, tickEnd, inset = 0, gap = 0, open = true, rise, children }: { x: number; tickEnd: number; inset?: number; gap?: number; open?: boolean; rise?: number; children: ReactNode }) {
  const [mountedAt] = useState(() => performance.now())
  const [entered] = useState(() => mountedAt - openedAt < OPEN_WINDOW_MS)
  const mode = !open ? 'leave' : entered ? 'enter' : null
  const value = useMemo<GroupState>(() => ({ x, tickEnd, inset, gap, mode, mountedAt, rise }), [x, tickEnd, inset, gap, mode, mountedAt, rise])
  return <Group.Provider value={value}>{children}</Group.Provider>
}

interface Slot { shape: TreeShape; motion: TreeMotionState | null }
const SlotContext = createContext<Slot | null>(null)

/**
 * One child of a `TreeGroup`. It adds no box: the row draws its own slice inside its root (`useTreeSlot`), because every
 * extra flex level around Markdown multiplies its measuring (a three-level wrapper cost a 12 s first layout). `anchor` is
 * the y of the row's icon centre; prose rows join as `pass` (the stem runs past them).
 */
export function TreeItem({ joint, last, index, count, anchor, tickEnd, children }: { joint: Joint; last: boolean; index: number; count: number; anchor: number; tickEnd?: number; children: ReactNode }) {
  const group = useContext(Group)
  // A row that mounts well after its group is a new arrival (a live tool call): it draws in alone.
  const [arrived] = useState(() => !!group && performance.now() - group.mountedAt > 100)
  const slot = useMemo<Slot | null>(() => {
    if (!group) return null
    const shape: TreeShape = { branch: { x: group.x, joint, last, tickEnd: tickEnd ?? group.tickEnd }, anchor, top: index === 0 ? -group.inset : 0, overlap: group.gap }
    // Only its connectors draw on arrival: a live row brings its own entrance (`Rise`).
    const motion: TreeMotionState | null = group.mode === 'leave' ? { mode: 'leave', index, count, rise: group.rise }
      : arrived ? { mode: 'enter', index: 0, count: 1, rise: 0, lead: ARRIVAL_LEAD }
      : group.mode === 'enter' ? { mode: 'enter', index, count, rise: group.rise } : null
    return { shape, motion }
  }, [group, joint, last, index, count, anchor, tickEnd, arrived])
  return <SlotContext.Provider value={slot}>{children}</SlotContext.Provider>
}

/** The rest of a row after its head (prose under a "Thought" line): the stem only runs past it. */
function restOf(shape: TreeShape): TreeShape {
  return { anchor: shape.anchor, rails: shape.rails, overlap: shape.overlap, ...(shape.branch ? { branch: { ...shape.branch, joint: 'pass' } } : {}) }
}

/**
 * A row's place in its `TreeItem`: render `lines` as the last child of the row's root (which must be `position: relative`)
 * and put `rise` on that root. Outside a group both are empty. `part: 'rest'` is a second box of the same row.
 */
export function useTreeSlot(part: 'head' | 'rest' = 'head'): { lines: ReactNode; rise: PaintTransformProps | undefined; inTree: boolean } {
  const slot = useContext(SlotContext)
  const rise = useRise(slot?.motion ?? null)
  const shape = useMemo(() => (slot ? (part === 'rest' ? restOf(slot.shape) : slot.shape) : null), [slot, part])
  if (!slot || !shape) return { lines: null, rise: undefined, inTree: false }
  return { lines: <TreeLines shape={shape} motion={slot.motion} />, rise, inTree: true }
}

/** Rows inside that do not take this slot (several rows standing in for one item). */
export function NoTreeSlot({ children }: { children: ReactNode }) {
  return <SlotContext.Provider value={null}>{children}</SlotContext.Provider>
}

/** A row whose root is not ours (a launch member): one small box carries its slice. Never wrap Markdown this way. */
export function TreeBox({ children }: { children: ReactNode }) {
  const tree = useTreeSlot()
  if (!tree.inTree) return <>{children}</>
  return (
    <div paintTransform={tree.rise} style={{ position: 'relative', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      {children}
      {tree.lines}
    </div>
  )
}
