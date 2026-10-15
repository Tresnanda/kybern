import { isWindowVisible } from '../native/visibility.ts'
import { useLoaderStep } from '../MatrixLoader.tsx'
import { useEffect, useSyncExternalStore } from 'react'
import { motion, type ElementBounds, type EventPayload, type NativeRenderer, type PublicInstance } from '@gpuix/react'
import { dropAction } from '@/state/tasksModel'
import type { TaskStatus } from '../../../../packages/kybern-client/src/types.ts'
import { addWindowKeyHandler } from '../nav/keys.ts'
import { EASE_OUT, Label, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { openTask, pick, setTasks, taskState, updateTask } from './store.ts'

type Region = { node: PublicInstance; status: TaskStatus; ids: string[]; board: boolean }
type Target = { status: TaskStatus; before: string | null; line: ElementBounds }
type Drag = {
  id: string
  x: number
  y: number
  startX: number
  startY: number
  active: boolean
  target: Target | null
  regions: (Region & { bounds: ElementBounds })[]
  rows: Map<string, ElementBounds>
  select: boolean
  range: boolean
  sequence: string[]
}
const scrollLists = new Map<number, { node: PublicInstance; count: number; mount?: (index: number) => void }>()
let dragRenderer: NativeRenderer | null = null
/** `mount` mounts the rows around an index; edge scrolling calls it first, because a native scroll does not report a new visible range until a later frame. */
export function taskScrollRef(node: PublicInstance | null, previous: PublicInstance | null, count: number, mount?: (index: number) => void) {
  if (previous) scrollLists.delete(previous.id)
  if (node) scrollLists.set(node.id, { node, count, mount })
}
const rows = new Map<string, PublicInstance>()
const regions = new Map<string, Region>()
let viewport: PublicInstance | null = null
let current: Drag | null = null
let pending: Drag | null = null
const listeners = new Set<() => void>()
function publish(value: Drag | null) {
  current = value
  listeners.forEach((fn) => fn())
}
export const draggingTask = () => current !== null
export const cancelTaskDrag = () => {
  pending = null
  publish(null)
}
export function useTaskLift(id: string) {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    () => (current?.active && current.id === id ? true : false),
  )
}
export function rowRef(id: string, node: PublicInstance | null) {
  if (node) rows.set(id, node)
  else rows.delete(id)
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
  for (const [key, node] of rows) {
    const b = renderer.getElementBounds?.(node.id)
    if (b && b.height > 0 && b.y >= frame.y && b.y < frame.y + frame.height) boxes.set(key, b)
  }
  // A status header may be above the mounted range. Its visible rows still form a drop region.
  if (taskState().prefs.view === 'list') {
    for (const [key, bounds] of boxes) {
      const status = taskState().tasks[key]?.status
      if (!status || visible.some((region) => region.status === status)) continue
      visible.push({
        node: rows.get(key)!,
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
export function beginTaskDrag(id: string, event: EventPayload, renderer: NativeRenderer, sequence: string[]) {
  if (event.button !== 0 || event.x === undefined || event.y === undefined) return
  const targets = measureTargets(renderer, sequence)
  if (!targets) return
  dragRenderer = renderer
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
  }
}
export function trackTaskDrag(event: EventPayload) {
  if (!pending) return
  if (event.pressedButton !== 0) {
    pending = null
    return
  }
  const x = event.x ?? pending.x,
    y = event.y ?? pending.y
  if (Math.hypot(x - pending.startX, y - pending.startY) < 5) return
  current = pending
  pending = null
  move(event)
}
export function endPendingDrag() {
  pending = null
}
function move(event: EventPayload) {
  if (!current) return
  if (event.pressedButton !== 0) return cancelTaskDrag()
  if (dragRenderer) {
    const targets = measureTargets(dragRenderer, current.sequence)
    if (targets) { current.regions = targets.regions; current.rows = targets.rows }
  }
  const x = event.x ?? current.x,
    y = event.y ?? current.y
  const active = current.active || Math.hypot(x - current.startX, y - current.startY) >= 5
  let target: Target | null = null
  if (active) {
    const region = current.regions.find(({ bounds: b }) => x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height)
    if (region) {
      const candidates = region.ids.filter((id) => id !== current!.id)
      const before =
        candidates.find((id) => {
          const b = current!.rows.get(id)
          return b && y < b.y + b.height / 2
        }) ?? null
      const b = before
        ? current.rows.get(before)
        : candidates
            .map((id) => current!.rows.get(id))
            .filter(Boolean)
            .at(-1)
      target = {
        status: region.status,
        before,
        line: {
          x: region.bounds.x + 4,
          y: b ? (before ? b.y : b.y + b.height) : region.bounds.y + (region.board ? 46 : 36),
          width: region.bounds.width - 8,
          height: 2,
        },
      }
    }
  }
  publish({ ...current, x, y, active, target })
}
let lastScroll = 0
function scrollEdge() {
    if (!current?.active || !dragRenderer || !isWindowVisible() || performance.now() - lastScroll < 100) return
    for (const { node, count, mount } of scrollLists.values()) {
      // A native virtual list reports no bounds of its own; the list view's viewport wrapper is the same rectangle.
      const box = dragRenderer.getElementBounds?.(node.id) ?? (scrollLists.size === 1 && viewport ? dragRenderer.getElementBounds?.(viewport.id) : null)
      if (!box || current.x < box.x || current.x > box.x + box.width) continue
      const direction = current.y >= box.y - 12 && current.y < box.y + 36 ? -1 : current.y > box.y + box.height - 36 && current.y <= box.y + box.height + 12 ? 1 : 0
      if (!direction) continue
      lastScroll = performance.now()
      const anchor = dragRenderer.getListScrollTop?.(node.id)
      if (anchor) {
        const index = Math.max(0, Math.min(count - 1, (anchor[0] ?? 0) + direction))
        mount?.(index)
        dragRenderer.scrollToItem?.(node.id, index)
      }
      move({ elementId: node.id, eventType: 'mouseMove', x: current.x, y: current.y, pressedButton: 0 })
      break
    }
}
function EdgeScroll() {
  const step = useLoaderStep()
  useEffect(scrollEdge, [step])
  // Autoscroll is functional interaction, so it remains available with Reduce Motion.
  useEffect(() => {
    if (!REDUCED_MOTION) return
    const timer = setInterval(scrollEdge, 200)
    return () => clearInterval(timer)
  }, [])
  return null
}

function finish() {
  const drag = current
  cancelTaskDrag()
  if (!drag) return
  if (!drag.active) {
    if (drag.select) pick(drag.id, drag.sequence, drag.range)
    else openTask(drag.id)
    return
  }
  const task = taskState().tasks[drag.id],
    target = drag.target
  if (!task || !target) return
  const action = dropAction(target.status)
  if (action === 'send') {
    if (task.status !== 'running') setTasks({ composer: [task.id] })
    return
  }
  if (action === 'none') return
  const manual = taskState().prefs.ordering === 'manual' && target.status !== 'done' && target.status !== 'canceled'
  if (!manual && task.status === target.status) return
  void updateTask(task.id, { status: target.status, before_id: manual ? target.before : null }).catch(() => {})
}

/** Transparent root capture, like SidebarDragLayer; only this small overlay tracks pointer moves. */
export function TasksDragLayer() {
  const t = useTheme()
  const drag = useSyncExternalStore(
    (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    () => current,
  )
  useEffect(
    () =>
      addWindowKeyHandler((e) => {
        if (current && e.key === 'escape') {
          cancelTaskDrag()
          return true
        }
      }),
    [],
  )
  if (!drag) return null
  const action = drag.target ? dropAction(drag.target.status) : 'none'
  const title = taskState().tasks[drag.id]?.title ?? 'Task'
  return (
    <div
      testId="task-drag-layer"
      onMouseMove={(event) => { move(event); if (REDUCED_MOTION) scrollEdge() }}
      onMouseUp={finish}
      onMouseLeave={cancelTaskDrag}
      style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', cursor: drag.active ? 'grabbing' : 'pointer' }}
    >
      <EdgeScroll />
      {drag.active && (
        <>
          {drag.target && (
            <div
              testId="task-drop-indicator"
              style={{
                position: 'absolute',
                ...drag.target.line,
                left: drag.target.line.x,
                top: drag.target.line.y,
                backgroundColor: action === 'none' ? t.red : t.taskRun,
                pointerEvents: 'none',
              }}
            />
          )}
          <div
            style={{
              position: 'absolute',
              left: drag.x + (REDUCED_MOTION ? 0 : 10),
              top: drag.y + (REDUCED_MOTION ? 0 : 10),
              width: 260,
              pointerEvents: 'none',
            }}
          >
            <motion.div
              initial={{ opacity: 0.7 }}
              animate={{ opacity: 0.95 }}
              transition={{ duration: REDUCED_MOTION ? 0 : 0.15, ease: EASE_OUT }}
              style={{
                padding: 12,
                backgroundColor: t.surface,
                borderWidth: 1,
                borderColor: t.border,
                borderRadius: 8,
                pointerEvents: 'none',
              }}
            >
              <Label size={13} color={t.text} truncate style={{ pointerEvents: 'none' }}>
                {title}
              </Label>
              <Label size={12} color={t.textTertiary} style={{ pointerEvents: 'none' }}>
                {action === 'send' ? 'Send to agent' : action === 'none' ? 'Cannot drop here' : 'Move task'}
              </Label>
            </motion.div>
          </div>
        </>
      )}
    </div>
  )
}
