// Drag a dock tab to reorder the strip. Same layer as projects and tasks (`src/drag/`): the tabs between
// the old and new slot slide by a layout-neutral translation, a ghost carries the pointer from the exact
// grab offset, release springs it into the gap with the pointer velocity, Escape springs it home, and the
// strip auto-scrolls near its ends. The order is committed at release, in the frame the shifts snap to 0.
import { motion, type EventPayload, type NativeRenderer, type PublicInstance } from '@gpuix/react'
import { useEffect, useSyncExternalStore } from 'react'
import { dropIndex } from '@/state/sidebarOrganize'
import { isWindowVisible } from '../native/visibility.ts'
import { Icon } from '../icons.tsx'
import { addWindowKeyHandler } from '../nav/keys.ts'
import { Label, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { DragGhost, DropSlot, type Rect, type Settle } from '../drag/Ghost.tsx'
import { leftCapture } from '../drag/leave.ts'
import { edgeSpeed, startFrameLoop } from '../drag/edge.ts'
import { usePacing } from '../drag/pacing.ts'
import { createShiftStore, ShiftRow } from '../drag/shift.tsx'
import { createVelocityTracker } from '../drag/velocity.ts'
import { moveTab, type DockTab } from './store.ts'

const THRESHOLD = 5
const GAP = 4
export type TabContext = { threadId: string | null; ids: DockTab[]; widths: number[]; icons: string[]; labels: string[]; scroll: PublicInstance | null; row: PublicInstance | null }
const context: TabContext = { threadId: null, ids: [], widths: [], icons: [], labels: [], scroll: null, row: null }
export function setTabContext(next: TabContext) { Object.assign(context, next) }

type Drag = {
  id: DockTab
  x: number
  y: number
  from: number
  to: number
  lefts: number[]
  source: Rect
  grab: { x: number; y: number }
  rowLeft: number
  viewLeft: number
  viewWidth: number
  scrollX: number
  slot: Rect | null
  settle: Settle | null
}
type Pending = { id: DockTab; x: number; y: number; rect: Rect; renderer: NativeRenderer }
let pending: Pending | null = null
let current: Drag | null = null
let renderer: NativeRenderer | null = null
let landed = false
let suppressed: { id: DockTab; until: number } | null = null
const listeners = new Set<() => void>()
const velocity = createVelocityTracker()
export const tabShift = createShiftStore()
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }
function publish(next: Drag | null) { current = next; listeners.forEach((fn) => fn()) }
export const isDraggingTab = () => !!current

/** True once for the click that ends a drag, so releasing does not also select the tab. */
export function consumeTabDrag(id: DockTab) {
  pending = null
  if (!suppressed || suppressed.id !== id) return false
  const yes = performance.now() <= suppressed.until
  suppressed = null
  return yes
}
export function beginTabDrag(id: DockTab, event: EventPayload, nativeRenderer: NativeRenderer | null | undefined, rect: Rect | null) {
  if (event.button !== 0 || event.x == null || event.y == null || !rect || !nativeRenderer || current || context.ids.length < 2) return
  pending = { id, x: event.x, y: event.y, rect: { ...rect }, renderer: nativeRenderer }
}
export function endTabPending() { pending = null }
export function trackTabDrag(event: EventPayload, leaving = false) {
  if (current) return move(event)
  if (!pending) return
  if (event.pressedButton != null && event.pressedButton !== 0) { pending = null; return }
  const x = event.x ?? pending.x, y = event.y ?? pending.y
  if (!leaving && Math.hypot(x - pending.x, y - pending.y) < THRESHOLD) return
  const start = pending
  pending = null
  activate(start, x, y)
}

function activate(start: Pending, x: number, y: number) {
  const { scroll, row } = context
  const from = context.ids.indexOf(start.id)
  const view = scroll && start.renderer.getElementBounds?.(scroll.id)
  const rowBox = row && start.renderer.getElementBounds?.(row.id)
  if (from < 0 || !view || !rowBox) return
  const lefts: number[] = []
  context.widths.reduce((n, w) => (lefts.push(n), n + w + GAP), 0)
  renderer = start.renderer
  renderer.clearSelection?.()
  landed = false
  velocity.reset(x, y)
  const source: Rect = { x: start.rect.x, y: start.rect.y, width: context.widths[from]!, height: start.rect.height }
  publish({ id: start.id, x, y, from, to: from, lefts, source, grab: { x: start.x - source.x, y: start.y - source.y }, rowLeft: rowBox.x, viewLeft: view.x, viewWidth: view.width, scrollX: view.x - rowBox.x, slot: source, settle: null })
  retarget(x, y)
}

function retarget(x: number, y: number) {
  const drag = current
  if (!drag || drag.settle) return
  const widths = context.widths
  const w = widths[drag.from]!
  const center = x - drag.grab.x - drag.rowLeft + w / 2
  const others = drag.lefts.map((l, i) => l + widths[i]! / 2).filter((_, i) => i !== drag.from)
  const to = dropIndex(others, center)
  const order = widths.map((_, i) => i).filter((i) => i !== drag.from)
  order.splice(to, 0, drag.from)
  const next = new Map<number, number>()
  order.reduce((n, i) => (next.set(i, n), n + widths[i]! + GAP), 0)
  const shifts = new Map<string, number>()
  context.ids.forEach((id, i) => {
    if (i === drag.from) return
    const delta = next.get(i)! - drag.lefts[i]!
    if (delta) shifts.set(id, delta)
  })
  tabShift.set(shifts)
  publish({ ...drag, x, y, to, slot: { x: drag.rowLeft + next.get(drag.from)!, y: drag.source.y, width: w, height: drag.source.height } })
}

function move(event: EventPayload) {
  const drag = current
  if (!drag || drag.settle) return
  if (event.pressedButton != null && event.pressedButton !== 0) return release(false)
  const x = event.x ?? drag.x, y = event.y ?? drag.y
  velocity.push(x, y)
  retarget(x, y)
}

function release(drop: boolean) {
  const drag = current
  if (!drag || drag.settle) return
  suppressed = { id: drag.id, until: performance.now() + 500 }
  const v = velocity.velocity()
  if (drop && drag.to !== drag.from) {
    moveTab(context.threadId, drag.id, drag.to)
    tabShift.clear(true)
    publish({ ...drag, slot: null, settle: { to: { x: drag.slot!.x, y: drag.slot!.y }, vx: v.x, vy: 0, home: false } })
    return
  }
  tabShift.clear()
  const keep = drop ? 0.4 : 0
  publish({ ...drag, slot: null, settle: { to: { x: drag.source.x, y: drag.source.y }, vx: v.x * keep, vy: 0, home: true } })
}
function escape() { pending = null; if (current) release(false) }
function finish() { landed = false; publish(null) }
export const cancelTabDrag = () => { pending = null; tabShift.clear(true); finish() }

function scrollStep(dt: number) {
  const drag = current
  const { scroll, row } = context
  if (!drag || drag.settle || !renderer || !scroll || !row || !isWindowVisible()) return
  const speed = edgeSpeed(drag.x, drag.viewLeft, drag.viewLeft + drag.viewWidth, 40, 700)
  if (!speed) return
  const total = context.widths.reduce((n, w) => n + w + GAP, 0)
  const scrollX = Math.max(0, Math.min(Math.max(0, total - drag.viewWidth), drag.scrollX + speed * dt))
  if (scrollX === drag.scrollX) return
  renderer.scrollTo?.(scroll.id, -scrollX, 0)
  // The strip moved under the pointer: tab positions are row-relative, so only the row origin changes.
  current = { ...drag, scrollX, rowLeft: drag.rowLeft - (scrollX - drag.scrollX), slot: drag.slot }
  retarget(drag.x, drag.y)
}

/** Window-root layer: transparent pointer capture, the drop slot and the tab ghost. */
export function TabDragLayer() {
  const pacing = usePacing('dock-tabs')
  const t = useTheme()
  const drag = useSyncExternalStore(subscribe, () => current)
  const active = !!drag
  useEffect(() => addWindowKeyHandler((e) => { if (current && e.key === 'escape') { escape(); return true } }), [])
  useEffect(() => (active ? startFrameLoop(scrollStep) : undefined), [active])
  if (!drag) return null
  const i = drag.from
  return (
    <div testId="dock-tab-drag-layer" onMouseMove={move} onMouseUp={() => release(true)} onMouseLeave={(event) => { if (leftCapture(event, renderer)) escape() }}
      style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', pointerEvents: drag.settle ? 'none' : 'auto', cursor: 'grabbing' }}>
      <DropSlot testId="dock-tab-drop-indicator" rect={drag.settle ? null : drag.slot} tone="ok" />
      <DragGhost rect={drag.source} grab={drag.grab} x={drag.x} y={drag.y} settle={drag.settle} onSettled={() => { if (!landed) { landed = true; finish() } }} radius={8} pacing={pacing as never}>
        <div style={{ pointerEvents: 'none', display: 'flex', alignItems: 'center', gap: 6, height: '100%', paddingLeft: 6 }}>
          <Icon source={context.icons[i]!} size={14} color={t.textSecondary} />
          <Label color={t.text} size={13}>{context.labels[i] ?? ''}</Label>
        </div>
      </DragGhost>
    </div>
  )
}

/** Wraps one tab: the layout-neutral shift, and a fade-out while that tab is the one held. */
export function TabSlot({ id, children }: { id: DockTab; children: React.ReactNode }) {
  const hide = useSyncExternalStore(subscribe, () => !!current && current.id === id && !current.settle)
  return (
    <ShiftRow store={tabShift} id={id} axis="x">
      <motion.div initial={false} animate={{ opacity: hide ? 0 : 1 }} transition={{ duration: REDUCED_MOTION || hide ? 0 : 0.14 }} style={{ display: 'flex', alignItems: 'center', height: 28, flexShrink: 0 }}>
        {children}
      </motion.div>
    </ShiftRow>
  )
}
