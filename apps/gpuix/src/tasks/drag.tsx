import { isWindowVisible } from '../native/visibility.ts'
import { useEffect, useSyncExternalStore } from 'react'
import { type ElementBounds, type EventPayload, type NativeRenderer, type PublicInstance } from '@gpuix/react'
import { dropAction } from '@/state/tasksModel'
import type { TaskStatus } from '../../../../packages/kybern-client/src/types.ts'
import { addWindowKeyHandler } from '../nav/keys.ts'
import { Label, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { openTask, pick, setTasks, taskState, updateTask } from './store.ts'

import { recordDragPointer, usePacing } from '../drag/pacing.ts'
import type { Rect, Settle } from '../drag/Ghost.tsx'
import { createCarryStore } from '../drag/carry.ts'
import { TaskCarryGhost } from './CarryGhost.tsx'
import { createShiftStore } from '../drag/shift.tsx'
import { leftCapture } from '../drag/leave.ts'
import { edgeSpeed, startFrameLoop } from '../drag/edge.ts'
import { createVelocityTracker } from '../drag/velocity.ts'
import { GhostCard, GhostRow } from './GhostItem.tsx'
import { getState } from '../state.ts'
import { watchPointerRelease } from '../split/release.ts'
import { cls, getObjc, nsApp, sel } from '../native/objc.ts'

type Region = { node: PublicInstance; status: TaskStatus; ids: string[]; board: boolean }
type Target = { status: TaskStatus; before: string | null; slot: Rect; action: 'move' | 'send' | 'none'; shifts: Map<string, number> }
type Drag = {
  id: string
  x: number
  y: number
  startX: number
  startY: number
  active: boolean
  target: Target | null
  regions: (Region & { bounds: ElementBounds })[]
  /** Unshifted slot boxes (the card without its 8px gap), from the list's own slot wrappers. */
  rows: Map<string, ElementBounds>
  select: boolean
  range: boolean
  sequence: string[]
  /** Source box, pointer offset inside it and the dragged row's full pitch (box + gap). */
  source: Rect | null
  grab: { x: number; y: number }
  step: number
  gap: number
  settle: Settle | null
  /** The RPC of a drop is still in flight. */
  saving: boolean
}
type ScrollList = { node: PublicInstance; count: number; mount?: (index: number) => void; heights: number[]; viewport?: PublicInstance | null; keys: string[] }
const scrollLists = new Map<number, ScrollList>()
let dragRenderer: NativeRenderer | null = null
/** `mount` mounts the rows around an index; edge scrolling calls it first, because a native scroll does not report a new visible range until a later frame. */
export function taskScrollRef(node: PublicInstance | null, previous: PublicInstance | null, count: number, mount?: (index: number) => void, heights: number[] = [], viewport?: PublicInstance | null, keys: string[] = []) {
  if (previous) scrollLists.delete(previous.id)
  if (node) scrollLists.set(node.id, { node, count, mount, heights, viewport, keys })
}
const rows = new Map<string, PublicInstance>()
const slots = new Map<string, PublicInstance>()
const regions = new Map<string, Region>()
let viewport: PublicInstance | null = null
let current: Drag | null = null
// React observes lifecycle/hint changes; native motion observes pointer coordinates.
let snapshot: Drag | null = null
const taskCarry = createCarryStore()
let pending: Drag | null = null
// Native click delivery may still target the pressed row after the overlay mounts.
// Keep this through landing/cancel; only a new press starts a click gesture.
let suppressTaskClick = false
let stopReleaseWatch: (() => void) | undefined
function stopWatchingRelease() {
  stopReleaseWatch?.()
  stopReleaseWatch = undefined
}
function watchRelease() {
  stopWatchingRelease()
  if (process.platform !== 'darwin') return
  const o = getObjc(), app = nsApp()
  stopReleaseWatch = watchPointerRelease(() => ({
    pressed: (Number(o.msgU64(cls(o, 'NSEvent'), sel(o, 'pressedMouseButtons'))) & 1) !== 0,
    active: !!app && Number(o.msgU64(app, sel(o, 'isActive'))) !== 0,
  }), escapeTaskDrag)
}
export function taskDragConsumesClick() {
  return suppressTaskClick || !!current?.active
}
export function endTaskDrag() {
  debugDrag('release')
  stopWatchingRelease()
  pending = null
  releaseDrag()
}
const listeners = new Set<() => void>()
const velocity = createVelocityTracker()
let ghostLanded = false
/** Spring offsets of the rows that make room; see `drag/shift.tsx`. */
export const taskShift = createShiftStore()
function publish(value: Drag | null) {
  current = value
  snapshot = value
  listeners.forEach((fn) => fn())
}
export const draggingTask = () => current !== null
/** Immediate cancel (page changes, environment switches). */
export const cancelTaskDrag = () => {
  stopWatchingRelease()
  pending = null
  ghostLanded = false
  taskShift.clear(true)
  publish(null)
}
/** Release the held item without a drop: it springs back to where it was picked up. */
export function escapeTaskDrag() {
  debugDrag('cancel')
  stopWatchingRelease()
  pending = null
  if (!current) return
  if (!current.active || !current.source) return cancelTaskDrag()
  if (current.settle) return
  taskShift.clear()
  publish({ ...current, target: null, settle: { to: homePosition(current), vx: 0, vy: 0, home: true } })
}
const subscribe = (fn: () => void) => {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
/** tasks.css dims the held source to .35; dnd-kit's default drop side effect
 * hides it completely while the overlay returns, then restores its opacity. */
export function useTaskDragOpacity(id: string) {
  return useSyncExternalStore(subscribe, () => current?.active && current.id === id ? current.settle ? 0 : 0.35 : 1)
}
/** Keep the pressed host alive if the React mount window scrolls past it. */
export function useHeldTask() {
  return useSyncExternalStore(subscribe, () => current?.active ? current.id : null)
}
export function rowRef(id: string, node: PublicInstance | null) {
  if (node) rows.set(id, node)
  else rows.delete(id)
}
/** The list's own slot wrapper for an entry: it is never translated, so its box is the unshifted layout. */
export function slotRef(id: string, node: PublicInstance | null) {
  if (node) slots.set(id, node)
  else slots.delete(id)
}
export function regionRef(key: string, node: PublicInstance | null, status: TaskStatus, ids: string[], board: boolean) {
  if (node) regions.set(key, { node, status, ids, board })
  else regions.delete(key)
}
export function viewportRef(node: PublicInstance | null) {
  viewport = node
}
export function revealTask(id: string, renderer: NativeRenderer) {
  const node = rows.get(id)
  if (node) renderer.scrollIntoView?.(node.id)
}
export function taskVisible(id: string, renderer: NativeRenderer) {
  const node = rows.get(id),
    box = node && renderer.getElementBounds?.(node.id),
    frame = viewport && renderer.getElementBounds?.(viewport.id)
  return !!box && !!frame && box.height > 0 && box.y >= frame.y && box.y + box.height <= frame.y + frame.height
}
function measureTargets(renderer: NativeRenderer, sequence: string[]) {
  const frame = viewport && renderer.getElementBounds?.(viewport.id)
  if (!frame) return null
  const visible = [...regions.values()]
    .flatMap((region) => {
      const bounds = renderer.getElementBounds?.(region.node.id)
      return bounds && bounds.height > 0 && bounds.y < frame.y + frame.height && bounds.y + bounds.height > frame.y
        ? [{ ...region, bounds: { ...bounds } }]
        : []
    })
    .sort((a, b) => a.bounds.y - b.bounds.y)
  const boxes = new Map<string, ElementBounds>()
  const board = taskState().prefs.view === 'board'
  for (const [key, node] of slots) {
    if (!taskState().tasks[key]) continue
    const b = renderer.getElementBounds?.(node.id)
    if (b && b.height > 0 && b.y + b.height > frame.y && b.y < frame.y + frame.height) boxes.set(key, board ? { ...b, height: b.height - 8 } : b)
  }
  // A status header may be above the mounted range. Its visible rows still form a drop region.
  if (taskState().prefs.view === 'list') {
    for (const [key, bounds] of boxes) {
      const status = taskState().tasks[key]?.status
      if (!status || visible.some((region) => region.status === status)) continue
      visible.push({
        node: slots.get(key)!,
        status,
        board: false,
        ids: sequence.filter((other) => taskState().tasks[other]?.status === status),
        bounds: { ...bounds, x: frame.x, width: frame.width },
      })
    }
    visible.sort((a, b) => a.bounds.y - b.bounds.y)
  }
  visible.forEach((region, i) => {
    if (!region.board) region.bounds.height = (visible[i + 1]?.bounds.y ?? frame.y + frame.height) - region.bounds.y
  })
  return { regions: visible, rows: boxes }
}
export function beginTaskDrag(id: string, event: EventPayload, renderer: NativeRenderer, sequence: string[], draggable = true) {
  debugDrag('press', event)
  if (event.button !== 0 || event.x === undefined || event.y === undefined) return
  suppressTaskClick = false
  if (!draggable) return
  const targets = measureTargets(renderer, sequence)
  if (!targets) return
  // A drag still landing is finished at once; the new press owns the pointer.
  if (current) cancelTaskDrag()
  ghostLanded = false
  scrollPx = null
  scrollingList = null
  dragRenderer = renderer
  const box = targets.rows.get(id)
  const board = taskState().prefs.view === 'board'
  velocity.reset(event.x, event.y)
  pending = {
    id,
    startX: event.x,
    startY: event.y,
    x: event.x,
    y: event.y,
    active: false,
    target: null,
    ...targets,
    select: !!(event.modifiers?.cmd || event.modifiers?.ctrl || event.modifiers?.shift),
    range: !!event.modifiers?.shift,
    sequence,
    source: box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null,
    grab: box ? { x: event.x - box.x, y: event.y - box.y } : { x: 12, y: 12 },
    gap: board ? 8 : 0,
    step: box ? box.height + (board ? 8 : 0) : 40,
    settle: null,
    saving: false,
  }
  watchRelease()
}
export function trackTaskDrag(event: EventPayload, leaving = false) {
  // GPUI's physical leftMouseDragged stream can stay on the pressed row after
  // the window capture layer mounts. Forward it just like trackProjectDrag.
  if (current) return move(event)
  if (!pending) return
  if (event.pressedButton != null && event.pressedButton !== 0) {
    endPendingDrag()
    return
  }
  const x = event.x ?? pending.x,
    y = event.y ?? pending.y
  if (!leaving && Math.hypot(x - pending.startX, y - pending.startY) < 5) return
  suppressTaskClick = true
  current = pending
  pending = null
  move(event)
}
export function endPendingDrag() {
  if (!current) stopWatchingRelease()
  pending = null
}
function resolveTarget(drag: Drag, x: number, y: number): Target | null {
  const region = drag.regions.find(({ bounds: b }) => x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height)
  if (!region || !drag.source) return null
  const task = taskState().tasks[drag.id]
  const action = dropAction(region.status)
  const manual = taskState().prefs.ordering === 'manual' && region.status !== 'done' && region.status !== 'canceled'
  const candidates = region.ids.filter((id) => id !== drag.id)
  let before: string | null = null
  if (action === 'move' && (manual || task?.status !== region.status)) {
    before = manual
      ? candidates.find((id) => {
          const b = drag.rows.get(id)
          return b && y < b.y + b.height / 2
        }) ?? null
      : null
  }
  // Rows make room only when a drop here would really move the task.
  const reorders = action === 'move' && (task?.status !== region.status || manual)
  const shifts = new Map<string, number>()
  if (reorders) {
    const original = taskState().tasks[drag.id] ? sourceIds(drag) : []
    const gone = original.indexOf(drag.id)
    for (const id of original.slice(gone + 1)) shifts.set(id, (shifts.get(id) ?? 0) - drag.step)
    const at = before ? candidates.indexOf(before) : candidates.length
    for (const id of candidates.slice(at)) shifts.set(id, (shifts.get(id) ?? 0) + drag.step)
  }
  let y0: number
  const anchor = before ? drag.rows.get(before) : candidates.map((id) => drag.rows.get(id)).filter(Boolean).at(-1)
  if (before && anchor) y0 = anchor.y + (shifts.get(before) ?? 0) - drag.step
  else if (anchor) {
    const last = candidates.filter((id) => drag.rows.get(id)).at(-1)!
    y0 = anchor.y + (shifts.get(last) ?? 0) + anchor.height + drag.gap
  } else y0 = region.bounds.y + (region.board ? 46 : 36)
  const first = candidates.map((id) => drag.rows.get(id)).find(Boolean)
  const x0 = region.board ? (first?.x ?? region.bounds.x) : drag.source.x
  const slot = { x: x0, y: reorders ? y0 : drag.source.y, width: drag.source.width, height: drag.source.height }
  if (!reorders) { slot.x = drag.source.x }
  return { status: region.status, before, slot, action, shifts: reorders ? shifts : new Map() }
}
/** Ids of the dragged row's own region, in their original order. */
function sourceIds(drag: Drag) {
  const status = taskState().tasks[drag.id]?.status
  const region = drag.regions.find((r) => r.status === status && r.ids.includes(drag.id))
  return region?.ids ?? drag.sequence.filter((id) => taskState().tasks[id]?.status === status)
}
/** Cancel returns to the source's current scroll position, including a source
 * that is no longer painted. Shifted child bounds cannot supply this geometry. */
function homePosition(drag: Drag) {
  for (const list of scrollLists.values()) {
    const index = list.keys.indexOf(drag.id)
    const anchor = dragRenderer?.getListScrollTop?.(list.node.id)
    const box = list.viewport && dragRenderer?.getElementBounds?.(list.viewport.id)
    if (index < 0 || !anchor || !box) continue
    const top = list.heights.slice(0, index).reduce((a,b) => a+b, 0)
    const scrolled = list.heights.slice(0, anchor[0] ?? 0).reduce((a,b) => a+b, 0) + (anchor[1] ?? 0)
    return {x:box.x,y:box.y + top - scrolled}
  }
  return {x:drag.source!.x,y:drag.source!.y}
}
/** Layout is measured at press and after an auto-scroll step, not on every pointer move (each measure is a native call per row). */
function move(event: EventPayload, remeasure = false) {
  if (!current || current.settle) return
  debugDrag('move', event)
  // Leave/layout notifications can omit button state. Only a reported release
  // ends capture; mouse-up and the physical release watcher own normal release.
  if (event.pressedButton != null && event.pressedButton !== 0) return releaseDrag()
  if (dragRenderer && remeasure) {
    const targets = measureTargets(dragRenderer, current.sequence)
    if (targets) { current.regions = targets.regions; current.rows = targets.rows }
  }
  const x = event.x ?? current.x,
    y = event.y ?? current.y
  if (current.active && x === current.x && y === current.y && !remeasure) return
  recordDragPointer(`tasks-${taskState().prefs.view}`, x - current.grab.x, y - current.grab.y)
  velocity.push(x, y)
  const active = current.active || Math.hypot(x - current.startX, y - current.startY) >= 5
  const target = active ? resolveTarget(current, x, y) : null
  taskShift.set(target?.shifts ?? new Map())
  const next = { ...current, x, y, active, target }
  const changed = current.active !== active || (current.target?.action ?? 'move') !== (target?.action ?? 'move')
  current = next
  taskCarry.set(x, y)
  if (changed) publish(next)
}
function debugDrag(kind: string, event?: EventPayload) {
  if (process.env.KYBERN_DEBUG_DRAG !== '1') return
  console.error('[task-drag]', JSON.stringify({kind, event: event?.eventType, element: event?.elementId, button: event?.pressedButton, x:event?.x, y:event?.y, task:current?.id ?? pending?.id, active:current?.active, settling:!!current?.settle}))
}
/** Pointer-up or button released elsewhere: drop where the slot is, or return home. */
function releaseDrag() {
  stopWatchingRelease()
  const drag = current
  if (!drag || drag.settle) return
  if (!drag.active || !drag.source) return finishClick(drag)
  const v = velocity.velocity()
  const task = taskState().tasks[drag.id]
  const target = drag.target
  const ok = !!task && !!target && target.action !== 'none'
  const moves = ok && target.action === 'move' && (taskState().prefs.ordering === 'manual' && target.status !== 'done' && target.status !== 'canceled' ? true : task.status !== target.status)
  if (ok && target.action === 'send') {
    if (task.status !== 'running') setTasks({ composer: [task.id] })
  }
  if (moves && target) {
    const manual = taskState().prefs.ordering === 'manual' && target.status !== 'done' && target.status !== 'canceled'
    publish({ ...drag, settle: { to: { x: target.slot.x, y: target.slot.y }, vx: v.x, vy: v.y, home: false }, saving: true })
    void updateTask(task.id, { status: target.status, before_id: manual ? target.before : null })
      .catch(() => {})
      .finally(() => {
        // The store has the new order: the real layout now matches the held shifts, so they jump to rest.
        taskShift.clear(true)
        if (current?.id === drag.id) publish({ ...current, saving: false })
        landed()
      })
    return
  }
  taskShift.clear()
  publish({ ...drag, target: null, settle: { to: homePosition(drag), vx: v.x * 0.4, vy: v.y * 0.4, home: true } })
}
function finishClick(drag: Drag) {
  cancelTaskDrag()
  if (drag.select) pick(drag.id, drag.sequence, drag.range)
  else openTask(drag.id)
}
function landed() {
  const drag = current
  if (!drag?.settle || drag.saving || !ghostLanded) return
  ghostLanded = false
  cancelTaskDrag()
}
function onGhostSettled() {
  ghostLanded = true
  landed()
}

let scrollPx: number | null = null
let scrollingList: number | null = null
function scrollEdge(dt: number) {
  const drag = current
  if (!drag?.active || drag.settle || !dragRenderer || !isWindowVisible()) { scrollPx = null; return }
  for (const { node, count, mount, heights, viewport: listViewport } of scrollLists.values()) {
    // A native virtual list reports no bounds of its own; the list view's viewport wrapper is the same rectangle.
    const box = listViewport ? dragRenderer.getElementBounds?.(listViewport.id) : dragRenderer.getElementBounds?.(node.id)
    if (!box || drag.x < box.x || drag.x > box.x + box.width) continue
    const speed = edgeSpeed(drag.y, box.y, box.y + box.height)
    if (!speed) { scrollPx = null; return }
    const anchor = dragRenderer.getListScrollTop?.(node.id)
    if (!anchor) return
    const total = heights.reduce((a, b) => a + b, 0)
    if (scrollPx === null || scrollingList !== node.id) scrollPx = heights.slice(0, anchor[0] ?? 0).reduce((a, b) => a + b, 0) + (anchor[1] ?? 0)
    scrollingList = node.id
    scrollPx = Math.max(0, Math.min(Math.max(0, total - box.height), scrollPx + speed * dt))
    let index = 0, rest = scrollPx
    while (index < count - 1 && rest >= (heights[index] ?? 40)) { rest -= heights[index] ?? 40; index++ }
    mount?.(index)
    // The preceding scroll is painted now. Read those boxes before queuing the
    // next scroll: scrollToItem does not synchronously update layout bounds.
    move({ elementId: node.id, eventType: 'mouseMove', x: drag.x, y: drag.y, pressedButton: 0 }, true)
    dragRenderer.scrollToItem?.(node.id, index, rest)
    return
  }
}
function EdgeScroll() {
  // Autoscroll is functional interaction, so it remains available with Reduce Motion.
  useEffect(() => startFrameLoop(scrollEdge), [])
  return null
}

function Hint({ action, color }: { action: 'move' | 'send' | 'none'; color: string }) {
  return action === 'move' ? null : (
    <Label size={12} color={color} truncate style={{ pointerEvents: 'none' }}>
      {action === 'send' ? 'Send to agent' : 'Cannot drop here'}
    </Label>
  )
}

/** Transparent root capture, like SidebarDragLayer; only this small overlay tracks pointer moves. */
export function TasksDragLayer() {
  const t = useTheme()
  const pacing = usePacing(`tasks-${taskState().prefs.view}`)
  const drag = useSyncExternalStore(subscribe, () => snapshot)
  useEffect(
    () =>
      addWindowKeyHandler((e) => {
        if (current && e.key === 'escape') {
          escapeTaskDrag()
          return true
        }
      }),
    [],
  )
  if (!drag) return null
  const task = taskState().tasks[drag.id]
  const action = drag.target?.action ?? 'move'
  return (
    <div
      testId="task-drag-layer"
      onMouseMove={(event) => move(event)}
      onMouseUp={endTaskDrag}
      onMouseLeave={(event) => { const left = leftCapture(event, dragRenderer); debugDrag(left ? 'leave-capture' : 'leave-child', event); if (left) escapeTaskDrag() }}
      style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', pointerEvents: drag.settle ? 'none' : 'auto', cursor: drag.active ? 'grabbing' : 'pointer' }}
    >
      {!drag.settle && <EdgeScroll />}
      {drag.active && drag.source && (
        <>
          <TaskCarryGhost store={taskCarry} rect={drag.source} grab={drag.grab} x={drag.x} y={drag.y} settle={drag.settle} onSettled={onGhostSettled} pacing={pacing}>
            {task && (taskState().prefs.view === 'board'
              ? <GhostCard task={task} />
              : <GhostRow task={task} project={getState().projects.find((p) => p.id === task.project_id)?.name ?? 'Global'} />)}
            {action !== 'move' && <Hint action={action} color={action === 'none' ? t.red : t.textTertiary} />}
          </TaskCarryGhost>
        </>
      )}
    </div>
  )
}
