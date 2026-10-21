// Drag a project header to reorder projects (desktop `projectReorder.ts`).
//
// The sidebar is one flat `<virtual-list>`, so a project is a run of rows: its header, its threads and
// children, "Show N more". Everything is computed from the row model (`rowHeight`), never from per-row
// layout reads: when the held header passes another project, every row of the projects between slides
// by a native translation (`BlockRow`, layout-neutral), the held project's rows are hidden, and a header
// ghost carries the pointer from the exact grab offset. Release springs the ghost into the gap with
// the pointer's velocity; Escape springs it home. `projectOrder` is committed at release, in the same
// frame the shifts snap to zero, so the real layout and the held shifts agree and nothing jumps.
import { motion, useGpuixRequired, type EventPayload, type NativeRenderer, type PublicInstance } from '@gpuix/react'
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { dropIndex, moveProject, orderProjects } from '@/state/sidebarOrganize'
import { isFreeChatProject } from '../../../../packages/kybern-client/src/types.ts'
import { isWindowVisible } from '../native/visibility.ts'
import { Icon } from '../icons.tsx'
import { N } from '../nav/glyphs.ts'
import { addWindowKeyHandler } from '../nav/keys.ts'
import { getNav, setNav } from '../nav/store.ts'
import { getState, subscribe as subscribeState } from '../state.ts'
import { currentSpaceId } from '../spaces/current.ts'
import { getSpaceScroller, hitSpaceTarget, measureSpaceTargets, publishSpaceDrag, spaceTargetCount, spaceTargetRect } from '../spaces/drop.ts'
import { getSpaces, moveProjectToSpace } from '../spaces/store.ts'
import { Label, ProviderMark, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { DragGhost, DropSlot, type Rect, type Settle } from '../drag/Ghost.tsx'
import { leftCapture } from '../drag/leave.ts'
import { edgeSpeed, startFrameLoop } from '../drag/edge.ts'
import { recordDragPointer, usePacing } from '../drag/pacing.ts'
import { createShiftStore } from '../drag/shift.tsx'
import { SPRING } from '../drag/spring.ts'
import { EASE } from '../motion/tokens.ts'
import { createVelocityTracker } from '../drag/velocity.ts'
import { bindNativeCarry, createCarryStore } from '../drag/carry.ts'
import { PaintTranslate } from '../drag/PaintTranslate.tsx'
import { rowHeight } from './motion.tsx'
import type { Row } from './model.ts'

const THRESHOLD = 6
/** The gap before every project but the first (the header's 12px top padding). */
const GAP = 12
const HEADER = 28
const END = 6
const BLOCK_KINDS = new Set<Row['kind']>(['project', 'thread', 'child', 'more', 'no-threads', 'create-coordinator'])
export const inProjectBlock = (row: Row) => BLOCK_KINDS.has(row.kind)

export type Block = { id: string; keys: string[]; top: number; height: number }
type Drag = {
  id: string
  x: number
  y: number
  startX: number
  startY: number
  blocks: Block[]
  from: number
  to: number
  source: Rect
  grab: { x: number; y: number }
  list: PublicInstance
  listTop: number
  listHeight: number
  heights: number[]
  settle: (Settle & { space?: boolean; from?: string | null }) | null
  slot: Rect | null
  /** The space tile the pointer is over (a drop moves the project there), or null. */
  space: string | null
  /** The held project's rows, drawn in the ghost: the whole block travels, as on the desktop. */
  members: Row[]
}
type Pending = { id: string; x: number; y: number; header: Rect; renderer: NativeRenderer }

const context: { rows: Row[]; list: PublicInstance | null; box: PublicInstance | null } = { rows: [], list: null, box: null }
/** Sidebar calls this on every render: the rows (for heights) and the two list nodes. */
export function setReorderContext(rows: Row[], list: PublicInstance | null, box: PublicInstance | null) {
  context.rows = rows
  context.list = list
  context.box = box
}

let pending: Pending | null = null
let current: Drag | null = null
let snapshot: Drag | null = null
const projectCarry = createCarryStore()
let renderer: NativeRenderer | null = null
let scrollPx = 0
let landed = false
let suppressed: { id: string; until: number } | null = null
const listeners = new Set<() => void>()
const velocity = createVelocityTracker()
export const projectShift = createShiftStore()
const subscribe = (fn: () => void) => {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
function publish(next: Drag | null) {
  current = next
  snapshot = next
  listeners.forEach((fn) => fn())
}
let hidden = new Set<string>()
/** The source block stays alive while its pointer capture/landing owns it. */
export function useHeldProjectRow(key: string) {
  return useSyncExternalStore(subscribe, () => hidden.has(key))
}
function setHidden(keys: string[]) {
  hidden = new Set(keys)
  listeners.forEach((fn) => fn())
}

/** True once for the click that ends a drag, so releasing does not also open the project. */
export function consumeProjectDrag(id: string) {
  pending = null
  if (!suppressed || suppressed.id !== id) return false
  const yes = performance.now() <= suppressed.until
  suppressed = null
  return yes
}
export function beginProjectDrag(id: string, event: EventPayload, nativeRenderer: NativeRenderer | null | undefined, header: Rect | null) {
  if (event.button !== 0 || event.x == null || event.y == null || !header || !nativeRenderer) return
  if (current) return
  pending = { id, x: event.x, y: event.y, header: { ...header }, renderer: nativeRenderer }
}
export function endProjectPending() {
  pending = null
}
/** `leaving`: the pointer left the header with the button held, which is a drag even before the threshold. */
export function trackProjectDrag(event: EventPayload, leaving = false) {
  if (current) return move(event)
  if (!pending) return
  // The first move after a press can carry no button state; only a reported release cancels.
  if (event.pressedButton != null && event.pressedButton !== 0) {
    pending = null
    return
  }
  const x = event.x ?? pending.x, y = event.y ?? pending.y
  if (!leaving && Math.hypot(x - pending.x, y - pending.y) < THRESHOLD) return
  const start = pending
  pending = null
  activate(start, x, y)
}

function layoutBlocks(rows: Row[]) {
  const blocks: Block[] = []
  const heights: number[] = []
  let y = 0
  let block: Block | null = null
  for (const row of rows) {
    const height = rowHeight(row) ?? 30
    heights.push(height)
    if (row.kind === 'project') {
      block = { id: row.project.id, keys: [row.key], top: y + (row.first ? 0 : GAP), height: height - (row.first ? 0 : GAP) }
      blocks.push(block)
    } else if (inProjectBlock(row) && block) {
      block.keys.push(row.key)
      block.height += height
    } else block = null
    y += height
  }
  return { blocks, heights }
}

function activate(start: Pending, x: number, y: number) {
  const { list, box } = context
  const frame = box && start.renderer.getElementBounds?.(box.id)
  if (!list || !frame) return
  const { blocks, heights } = layoutBlocks(context.rows)
  const from = blocks.findIndex((b) => b.id === start.id)
  // A project alone in its space can still be dragged onto another space's tile.
  if (from < 0 || (blocks.length < 2 && spaceTargetCount() === 0)) return
  const anchor = start.renderer.getListScrollTop?.(list.id)
  scrollPx = heights.slice(0, anchor?.[0] ?? 0).reduce((a, b) => a + b, 0) + (anchor?.[1] ?? 0)
  renderer = start.renderer
  renderer.clearSelection?.()
  landed = false
  velocity.reset(x, y)
  const source: Rect = { x: start.header.x, y: start.header.y, width: start.header.width, height: blocks[from]!.height }
  const members = context.rows.filter((row) => blocks[from]!.keys.includes(row.key))
  setHidden(blocks[from]!.keys)
  publish({
    id: start.id,
    x,
    y,
    startX: start.x,
    startY: start.y,
    blocks,
    from,
    to: from,
    source,
    grab: { x: start.x - source.x, y: start.y - source.y },
    list,
    listTop: frame.y,
    listHeight: frame.height,
    heights,
    settle: null,
    slot: source,
    space: null,
    members,
  })
  measureSpaceTargets(start.renderer)
  publishSpaceDrag({ active: spaceTargetCount() > 0, target: null })
  retarget(x, y)
}

/** New visual top of every block when `from` moves to index `to`. */
export function newTops(blocks: Block[], from: number, to: number) {
  const order = blocks.map((_, i) => i).filter((i) => i !== from)
  order.splice(to, 0, from)
  const tops = new Map<number, number>()
  let y = blocks[0]!.top
  for (const index of order) {
    tops.set(index, y)
    y += blocks[index]!.height + GAP
  }
  return tops
}

function retarget(x: number, y: number) {
  const drag = current
  if (!drag || drag.settle) return
  // Over another space's tile the list settles back to its real order and nothing reorders.
  const hit = hitSpaceTarget(x, y)
  const space = hit && hit !== currentSpaceId() ? hit : null
  publishSpaceDrag({ active: spaceTargetCount() > 0, target: space })
  if (space) {
    projectShift.clear()
    projectCarry.set(x, y)
    const next = { ...drag, x, y, to: drag.from, space, slot: null }
    if (drag.space === space && !drag.slot) current = next
    else publish(next)
    return
  }
  const top = y - drag.grab.y - drag.listTop + scrollPx
  const mids = drag.blocks.filter((_, i) => i !== drag.from).map((b) => b.top + HEADER / 2)
  const to = dropIndex(mids, top + HEADER / 2)
  const tops = newTops(drag.blocks, drag.from, to)
  const shifts = new Map<string, number>()
  drag.blocks.forEach((block, i) => {
    if (i === drag.from) return
    const delta = tops.get(i)! - block.top
    if (delta) for (const key of block.keys) shifts.set(key, delta)
  })
  projectShift.set(shifts)
  const dragged = drag.blocks[drag.from]!
  const slotY = drag.listTop + tops.get(drag.from)! - scrollPx
  const next = { ...drag, x, y, to, space: null, slot: { x: drag.source.x, y: slotY, width: drag.source.width, height: dragged.height } }
  projectCarry.set(x, y)
  // Carry coordinates have their own native subscription. React only observes
  // a changed gap, lifecycle or edge-scroll anchor.
  if (to === drag.to && slotY === drag.slot?.y && drag.space === null) current = next
  else publish(next)
}

function move(event: EventPayload) {
  const drag = current
  if (!drag || drag.settle) return
  if (event.pressedButton !== 0) return release(false)
  const x = event.x ?? drag.x, y = event.y ?? drag.y
  recordDragPointer('projects', x - drag.grab.x, y - drag.grab.y)
  velocity.push(x, y)
  retarget(x, y)
}

function release(drop: boolean) {
  const drag = current
  if (!drag || drag.settle) return
  suppressed = { id: drag.id, until: performance.now() + 500 }
  const v = velocity.velocity()
  publishSpaceDrag({ active: false, target: null })
  if (drop && drag.space) {
    const project = getState().projects.find((p) => p.id === drag.id)
    const target = getSpaces().spaces.find((space) => space.id === drag.space)
    const tile = spaceTargetRect(drag.space)
    if (project && target && tile) {
      void moveProjectToSpace(project, target)
      projectShift.clear()
      // The ghost lands in the tile and fades; the rows stay hidden until the project has left this space.
      publish({ ...drag, slot: null, settle: { to: { x: tile.x + 10, y: tile.y + 4 }, vx: 0, vy: 0, home: false, space: true, from: project.space_id ?? null } })
      return
    }
  }
  if (drop && drag.to !== drag.from) {
    const visible = drag.blocks.map((b) => b.id)
    const projects = getState().projects.filter((p) => !isFreeChatProject(p.id))
    const full = orderProjects(projects, getNav().projectOrder).map((p) => p.id)
    setNav({ projectOrder: moveProject(full, visible, drag.id, drag.to) })
    // The rows are laid out in the new order: the held shifts are now the real layout.
    projectShift.clear(true)
    publish({ ...drag, slot: null, settle: { to: { x: drag.slot!.x, y: drag.slot!.y }, vx: v.x, vy: v.y, home: false } })
    return
  }
  projectShift.clear()
  publish({ ...drag, slot: null, settle: { to: { x: drag.source.x, y: drag.source.y }, vx: drag.to === drag.from && drop ? v.x * 0.4 : 0, vy: drag.to === drag.from && drop ? v.y * 0.4 : 0, home: true } })
}
function escape() {
  pending = null
  if (current) release(false)
}
function finish() {
  landed = false
  setHidden([])
  publishSpaceDrag({ active: false, target: null })
  publish(null)
}

/** After a drop onto a tile: finish once the project no longer lists in the space it left (it reappears if the move fails). */
function finishWhenMoved(id: string, from: string | null) {
  const left = () => getState().projects.find((p) => p.id === id)?.space_id !== from
  if (left()) return finish()
  const stop = subscribeState(() => { if (left()) { stop(); finish() } })
  setTimeout(() => { stop(); if (current?.settle?.space) finish() }, 4000)
}
export const cancelProjectDrag = () => {
  pending = null
  projectShift.clear(true)
  finish()
}

/** Hovering the rail's top or bottom 24 px scrolls its tile list, like the sidebar's edges. */
function scrollRail(drag: Drag, dt: number) {
  const rail = getSpaceScroller()
  const bounds = rail && renderer?.getElementBounds?.(rail.id)
  if (!rail || !bounds || drag.x < bounds.x || drag.x > bounds.x + bounds.width) return false
  const speed = edgeSpeed(drag.y, bounds.y, bounds.y + bounds.height, 24)
  if (!speed) return false
  const offset = renderer!.getScrollOffset?.(rail.id)
  if (!offset) return false
  const next = Math.min(0, offset[1]! - speed * dt)
  if (next === offset[1]) return true
  renderer!.scrollTo?.(rail.id, 0, next)
  measureSpaceTargets(renderer)
  retarget(drag.x, drag.y)
  return true
}

function scrollStep(dt: number) {
  const drag = current
  if (!drag || drag.settle || !renderer || !isWindowVisible()) return
  if (scrollRail(drag, dt)) return
  const speed = edgeSpeed(drag.y, drag.listTop, drag.listTop + drag.listHeight)
  if (!speed) return
  const total = drag.heights.reduce((a, b) => a + b, 0) + END
  const nextScroll = Math.max(0, Math.min(Math.max(0, total - drag.listHeight), scrollPx + speed * dt))
  if (Math.abs(nextScroll - scrollPx) < 0.001) return
  scrollPx = nextScroll
  let index = 0, rest = scrollPx
  while (index < drag.heights.length - 1 && rest >= drag.heights[index]!) {
    rest -= drag.heights[index]!
    index++
  }
  renderer.scrollToItem?.(drag.list.id, index, rest)
  retarget(drag.x, drag.y)
}

/** Wraps one row of a project: a translation that springs, and a fade-in when the held project lands. */
export function BlockRow({ id, children }: { id: string; children: ReactNode }) {
  const shift = useSyncExternalStore(projectShift.subscribe, () => projectShift.get(id))
  const hide = useSyncExternalStore(subscribe, () => hidden.has(id))
  const snap = projectShift.instant()
  return (
    <PaintTranslate initial={false} animate={{ translateX: 0, translateY: shift }} transition={REDUCED_MOTION || snap ? { duration: 0 } : SPRING.shift} style={{ display: 'flex', flexDirection: 'column', width: '100%' }}>
      <motion.div initial={false} animate={{ opacity: hide ? 0 : 1 }} transition={{ duration: REDUCED_MOTION || hide ? 0 : 0.14 }} style={{ display: 'flex', flexDirection: 'column', width: '100%' }}>
        {children}
      </motion.div>
    </PaintTranslate>
  )
}

/** Mounted at the window root, like `TasksDragLayer`: a transparent capture layer, the drop slot and the header ghost. */
export function ProjectDragLayer() {
  const t = useTheme()
  const pacing = usePacing('projects')
  const drag = useSyncExternalStore(subscribe, () => snapshot)
  const active = !!drag
  useEffect(() => addWindowKeyHandler((e) => { if (current && e.key === 'escape') { escape(); return true } }), [])
  useEffect(() => (active ? startFrameLoop(scrollStep) : undefined), [active])
  if (!drag) return null
  const project = getState().projects.find((p) => p.id === drag.id)
  return (
    <div
      testId="project-drag-layer"
      onMouseMove={move}
      onMouseUp={() => release(true)}
      onMouseLeave={(event) => { if (leftCapture(event, renderer)) escape() }}
      style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', pointerEvents: drag.settle ? 'none' : 'auto', cursor: 'grabbing' }}
    >
      <DropSlot testId="project-drop-indicator" rect={drag.settle ? null : drag.slot} tone="ok" />
      <ProjectCarryGhost drag={drag} onSettled={() => { if (landed) return; landed = true; if (drag.settle?.space) finishWhenMoved(drag.id, drag.settle.from ?? null); else finish() }} pacing={pacing}>
        <div style={{ pointerEvents: 'none', display: 'flex', flexDirection: 'column', height: '100%', justifyContent: 'flex-start' }}>
          {drag.members.map((row) => <GhostRow key={row.key} row={row} />)}
        </div>
      </ProjectCarryGhost>
    </div>
  )
}

function ProjectCarryGhost({ drag, onSettled, pacing, children }: { drag: Drag; onSettled: () => void; pacing?: (node: PublicInstance | null) => void; children: ReactNode }) {
  const nativeRenderer = useGpuixRequired()
  const node = useRef<PublicInstance | null>(null)
  useLayoutEffect(() => node.current ? bindNativeCarry(nativeRenderer, node.current.id, { x: drag.source.x + drag.grab.x, y: drag.source.y + drag.grab.y }, projectCarry) : undefined, [nativeRenderer, drag.source, drag.grab])
  const left = drag.x - drag.grab.x, top = drag.y - drag.grab.y
  return <div testId="project-drag-ghost" ref={value => { node.current = value; pacing?.(value) }}
    paintTranslate={{ initial: false, animate: { translateX: 0, translateY: 0 }, transition: { duration: 0 } }}
    style={{ position: 'absolute', left: drag.source.x, top: drag.source.y, width: drag.source.width, height: drag.source.height, pointerEvents: 'none' }}>
    <DragGhost rect={{ x: 0, y: 0, width: drag.source.width, height: drag.source.height }} grab={drag.grab} x={drag.grab.x} y={drag.grab.y}
      settle={drag.settle ? { ...drag.settle, to: { x: drag.settle.to.x - left, y: drag.settle.to.y - top } } : null} onSettled={onSettled} radius={8}
      landing={drag.settle?.space ? { duration: 0.18, ease: [...EASE.out] as [number, number, number, number] } : undefined}>
      {/* Dropped onto a tile, the ghost fades as it lands (180 ms). */}
      <motion.div initial={false} animate={{ opacity: drag.settle?.space ? 0 : 1 }} transition={{ duration: REDUCED_MOTION ? 0 : 0.18, ease: [...EASE.out] as [number, number, number, number] }} style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%' }}>{children}</motion.div>
    </DragGhost>
  </div>
}

function GhostRow({ row }: { row: Row }) {
  const t = useTheme()
  const label = row.kind === 'project' ? row.project.name : row.kind === 'thread' || row.kind === 'child' ? row.thread.title || 'Untitled' : row.kind === 'more' ? `Show ${row.count} more` : row.kind === 'create-coordinator' ? 'Create coordinator' : row.kind === 'no-threads' ? 'No threads yet' : ''
  const header = row.kind === 'project'
  const indent = header ? 8 : 12 + (row.kind === 'thread' || row.kind === 'child' ? 20 + row.depth * 20 : 20)
  return (
    <div style={{ pointerEvents: 'none', display: 'flex', alignItems: 'center', gap: 8, height: header ? HEADER : (rowHeight(row) ?? 30), flexShrink: 0, paddingLeft: indent, paddingRight: 8 }}>
      {header && <Icon source={N.folder} size={16} color={t.textSecondary} />}
      {(row.kind === 'thread' || row.kind === 'child') && <ProviderMark kind={row.thread.provider.kind} size={14} />}
      <Label color={header ? t.text : t.textSecondary} truncate style={{ pointerEvents: 'none' }}>{label}</Label>
    </div>
  )
}
