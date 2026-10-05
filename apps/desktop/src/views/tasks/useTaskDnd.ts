// Drag and drop for the board's columns and the list's status groups (@dnd-kit).
// While dragging, the task moves between containers in a local copy so the
// destination makes room; on drop it moves for real (status and rank), opens
// Send to agent for Running, and refuses Needs review.
import {
  closestCenter,
  getFirstCollision,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core"
import { arrayMove } from "@dnd-kit/sortable"
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react"

import type { TaskItem, TaskItemId, TaskStatus } from "@/protocol"
import { moveTask, openSendSheet } from "@/state/tasks"
import { dropAction, placeAt } from "@/state/tasksModel"

export const containerId = (status: TaskStatus) => `col:${status}`
export const containerStatus = (id: string): TaskStatus | null => (id.startsWith("col:") ? (id.slice(4) as TaskStatus) : null)

export interface TaskDnd {
  /** Task ids per container, as they should render now (rearranged while dragging). */
  items: Record<string, TaskItemId[]>
  activeId: TaskItemId | null
  /** What a drop on the hovered container would do. */
  overAction: { container: string; action: "move" | "send" | "none" } | null
  sensors: ReturnType<typeof useSensors>
  collision: CollisionDetection
  onDragStart: (event: DragStartEvent) => void
  onDragOver: (event: DragOverEvent) => void
  onDragEnd: (event: DragEndEvent) => void
  onDragCancel: () => void
}

/**
 * `containers` maps `col:<status>` to the ids shown there, in order. `manual` is
 * whether that order is the tasks' rank (only then does reordering mean something).
 */
export function useTaskDnd(containers: Record<string, TaskItemId[]>, tasks: Record<TaskItemId, TaskItem>, manual: boolean): TaskDnd {
  const [drag, setDrag] = useState<{ activeId: TaskItemId; items: Record<string, TaskItemId[]>; from: string } | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const items = drag?.items ?? containers
  const itemsRef = useRef(items)
  useLayoutEffect(() => {
    itemsRef.current = items
  })

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  const find = useCallback((id: UniqueIdentifier | undefined | null, source = itemsRef.current): string | null => {
    if (id == null) return null
    const key = String(id)
    if (key in source) return key
    return Object.keys(source).find((container) => source[container]!.includes(key)) ?? null
  }, [])

  const collision = useCallback<CollisionDetection>((args) => {
    const pointer = pointerWithin(args)
    const hits = pointer.length > 0 ? pointer : rectIntersection(args)
    let overId = getFirstCollision(hits, "id")
    if (overId == null) return []
    const current = itemsRef.current
    const key = String(overId)
    if (key in current && current[key]!.length > 0) {
      // Over a column's empty space: aim at its nearest card instead.
      const ids = current[key]!
      overId = closestCenter({ ...args, droppableContainers: args.droppableContainers.filter((entry) => ids.includes(String(entry.id))) })[0]?.id ?? overId
    }
    return [{ id: overId }]
  }, [])

  const onDragStart = useCallback(
    (event: DragStartEvent) => {
      const id = String(event.active.id)
      const from = find(id, containers)
      if (!from) return
      setDrag({ activeId: id, items: Object.fromEntries(Object.entries(containers).map(([key, ids]) => [key, [...ids]])), from })
    },
    [containers, find],
  )

  const onDragOver = useCallback(
    ({ active, over: target }: DragOverEvent) => {
      const to = find(target?.id)
      setOver(to)
      const from = find(active.id)
      if (!to || !from || to === from) return
      const status = containerStatus(to)
      // Needs review belongs to the run: nothing lands there.
      if (status && dropAction(status) === "none") return
      setDrag((state) => {
        if (!state) return state
        const source = state.items[from]!.filter((id) => id !== String(active.id))
        const destination = [...state.items[to]!]
        const overIndex = destination.indexOf(String(target!.id))
        destination.splice(overIndex >= 0 ? overIndex : destination.length, 0, String(active.id))
        return { ...state, items: { ...state.items, [from]: source, [to]: destination } }
      })
    },
    [find],
  )

  const reset = useCallback(() => {
    setDrag(null)
    setOver(null)
  }, [])

  const onDragEnd = useCallback(
    ({ active, over: target }: DragEndEvent) => {
      const state = drag
      const id = String(active.id)
      const container = find(id)
      if (!state || !container || !target) return reset()
      let order = itemsRef.current[container]!
      const overIndex = order.indexOf(String(target.id))
      const activeIndex = order.indexOf(id)
      if (overIndex >= 0 && overIndex !== activeIndex) order = arrayMove(order, activeIndex, overIndex)
      const status = containerStatus(container)
      const task = tasks[id]
      reset()
      if (!status || !task) return
      const action = dropAction(status)
      if (action === "send") {
        if (task.status !== "running") openSendSheet(id)
        return
      }
      if (action === "none") return
      const sameColumn = container === state.from
      if (sameColumn && (!manual || order.indexOf(id) === state.items[container]!.indexOf(id))) return
      if (!manual || status === "done" || status === "canceled") {
        // The column is not in rank order: changing status only, to the end.
        if (sameColumn) return
        const ranks = (containers[container] ?? []).map((other) => tasks[other]?.rank ?? 0)
        void moveTask(id, { status, beforeId: null, rank: (ranks.length ? Math.max(...ranks) : 0) + 1024 })
        return
      }
      const column = order.map((other) => tasks[other]).filter((entry): entry is TaskItem => !!entry)
      const placement = placeAt(column, id, order.indexOf(id))
      void moveTask(id, { status, ...placement })
    },
    [drag, find, reset, tasks, manual, containers],
  )

  const overAction = useMemo(() => {
    if (!drag || !over) return null
    const status = containerStatus(over)
    return status ? { container: over, action: dropAction(status) } : null
  }, [drag, over])

  return { items, activeId: drag?.activeId ?? null, overAction, sensors, collision, onDragStart, onDragOver, onDragEnd, onDragCancel: reset }
}
