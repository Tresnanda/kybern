// The board: one column per status, no column outlines, cards that say what the
// agent is doing (running) or what it changed (needs review). Drag between Inbox,
// To do, Done and Canceled, and within a column to reorder. Dropping on Running
// opens Send to agent; Needs review takes no drops. Columns keep a readable width
// and the board scrolls sideways when the window is narrow.
import { DndContext, DragOverlay, useDroppable } from "@dnd-kit/core"
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { memo, useMemo, useState, type CSSProperties } from "react"
import { useReducedMotion } from "motion/react"

import { AddPlusIcon, ArrowUpRightIcon } from "@/lib/kit/icons"
import { relativeTime } from "@/lib/format"
import type { TaskItem, TaskItemId, TaskStatus } from "@/protocol"
import { openRunThread, openTask, setFocusedTask, startQuickAdd, useTasks } from "@/state/tasks"
import { isOpenStatus, latestRun, runChanges, runDuration, shortActivity, shortDuration, STATUS_LABEL } from "@/state/tasksModel"
import { ProjectDot } from "@/lib/kit/projectDot"
import { AgentMark, PriorityGlyph, TaskStatusGlyph } from "./TaskGlyphs"
import { QuickAddRow } from "./QuickAdd"
import { TaskProjectChip } from "./TaskMenus"
import { projectForNewTask } from "./taskActions"
import { containerId, useTaskDnd } from "./useTaskDnd"

/** Done shows its most recent cards; the rest wait behind "N more". */
const DONE_PREVIEW = 5

export function TaskBoard({ columns, tasks, now }: { columns: { status: TaskStatus; tasks: TaskItem[] }[]; tasks: Record<TaskItemId, TaskItem>; now: number }) {
  const ordering = useTasks((s) => s.prefs.ordering)
  const quickAdd = useTasks((s) => s.quickAdd)
  const focusedId = useTasks((s) => s.focusedId)
  const reducedMotion = useReducedMotion()
  const [doneOpen, setDoneOpen] = useState(false)
  const containers = useMemo(() => Object.fromEntries(columns.map((column) => [containerId(column.status), column.tasks.map((task) => task.id)])), [columns])
  const dnd = useTaskDnd(containers, tasks, ordering === "manual")
  const active = dnd.activeId ? tasks[dnd.activeId] : undefined

  return (
    <DndContext
      sensors={dnd.sensors}
      collisionDetection={dnd.collision}
      onDragStart={dnd.onDragStart}
      onDragOver={dnd.onDragOver}
      onDragEnd={dnd.onDragEnd}
      onDragCancel={dnd.onDragCancel}
      accessibility={{ screenReaderInstructions: { draggable: "Press S to change status. Drag with a pointer to move between columns." } }}
    >
      <div className="tk-board" role="list" aria-label="Board">
        {columns.map((column) => {
          const id = containerId(column.status)
          const ids = dnd.items[id] ?? []
          const capped = column.status === "done" && !doneOpen && ids.length > DONE_PREVIEW + 1
          const visible = capped ? ids.slice(0, DONE_PREVIEW) : ids
          const drop = dnd.overAction?.container === id ? (dnd.overAction.action === "move" ? "ok" : dnd.overAction.action === "send" ? "send" : "no") : undefined
          const canAdd = column.status === "inbox" || column.status === "todo"
          return (
            <Column key={column.status} id={id} drop={drop} label={STATUS_LABEL[column.status]}>
              <div className="tk-col-head">
                <TaskStatusGlyph status={column.status} animated />
                <span>{STATUS_LABEL[column.status]}</span>
                <span className="count">{column.tasks.length}</span>
                {canAdd && (
                  <button
                    type="button"
                    className="tk-btn add"
                    aria-label={`New task in ${STATUS_LABEL[column.status]}`}
                    onClick={() => startQuickAdd({ groupKey: `status:${column.status}`, status: column.status, projectId: projectForNewTask() })}
                  >
                    <AddPlusIcon className="size-3.5" />
                  </button>
                )}
              </div>
              <ColumnBody id={id}>
                {quickAdd?.groupKey === `status:${column.status}` && <QuickAddRow key={quickAdd.nonce} request={quickAdd} variant="card" />}
                <SortableContext items={visible} strategy={verticalListSortingStrategy}>
                  {visible.map((taskId) => {
                    const task = tasks[taskId]
                    return task ? <TaskCard key={taskId} task={task} now={now} focused={focusedId === taskId} /> : null
                  })}
                </SortableContext>
                {capped && (
                  <button type="button" className="tk-col-more" onClick={() => setDoneOpen(true)}>
                    {ids.length - visible.length} more
                  </button>
                )}
              </ColumnBody>
            </Column>
          )
        })}
      </div>
      <DragOverlay dropAnimation={reducedMotion ? null : undefined}>{active ? <CardContent task={active} now={now} overlay /> : null}</DragOverlay>
    </DndContext>
  )
}

function Column({ id, drop, label, children }: { id: string; drop?: string; label: string; children: React.ReactNode }) {
  return (
    <section className="tk-col" data-drop={drop} aria-label={label} data-column={id}>
      {children}
    </section>
  )
}

function ColumnBody({ id, children }: { id: string; children: React.ReactNode }) {
  const { setNodeRef } = useDroppable({ id })
  return (
    <div ref={setNodeRef} className="tk-col-body">
      {children}
    </div>
  )
}

const TaskCard = memo(function TaskCard({ task, now, focused }: { task: TaskItem; now: number; focused: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id })
  const style: CSSProperties = { transform: CSS.Translate.toString(transform), transition }
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      aria-roledescription={attributes["aria-roledescription"]}
      aria-describedby={attributes["aria-describedby"]}
      role="listitem"
      tabIndex={focused ? 0 : -1}
      data-task-card={task.id}
      data-focused={focused || undefined}
      data-closed={!isOpenStatus(task.status) || undefined}
      data-dragging={isDragging || undefined}
      className="tk-card"
      aria-label={`${task.key} ${task.title || "Untitled"}, ${STATUS_LABEL[task.status]}`}
      onFocus={() => setFocusedTask(task.id)}
      onClick={() => openTask(task.id)}
    >
      <CardInner task={task} now={now} />
    </div>
  )
})

function CardContent({ task, now, overlay }: { task: TaskItem; now: number; overlay?: boolean }) {
  return (
    <div className="tk-card" data-overlay={overlay || undefined} data-closed={!isOpenStatus(task.status) || undefined}>
      <CardInner task={task} now={now} overlay={overlay} />
    </div>
  )
}

function CardInner({ task, now, overlay }: { task: TaskItem; now: number; overlay?: boolean }) {
  const run = latestRun(task)
  const changes = run ? runChanges(run) : null
  let footer: React.ReactNode = null
  if (run && task.status === "running") {
    footer = (
      <div className="ft">
        <span className="mk">
          <AgentMark kind={run.provider.kind} />
        </span>
        <span className="act">{run.state === "waiting" ? "Waiting for you" : run.activity ? shortActivity(run.activity) : "Working"}</span>
        <span className="r">{shortDuration(runDuration(run, now))}</span>
      </div>
    )
  } else if (run && task.status === "needs_review") {
    footer = (
      <div className="ft">
        <span className="mk">
          <AgentMark kind={run.provider.kind} />
        </span>
        {changes && (
          <span className="tk-num" style={{ color: "var(--task-fg2)" }}>
            +{changes.added} −{changes.removed}
          </span>
        )}
        <span className="swap">
          <span className="time">
            <span>{changes ? `in ${changes.files} ${changes.files === 1 ? "file" : "files"}` : run.state === "failed" ? "Failed" : run.state === "interrupted" ? "Stopped" : "No changes"}</span>
            <span className="tk-num">{run.ended_at ? relativeTime(run.ended_at, now) : ""}</span>
          </span>
          <button
            type="button"
            className="open"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation()
              openRunThread(run.thread_id)
            }}
          >
            Open run
            <ArrowUpRightIcon className="size-3" aria-hidden />
          </button>
        </span>
      </div>
    )
  }
  return (
    <>
      <div className="r1">
        {overlay ? <ProjectDot projectId={task.scope === "project" ? task.project_id : null} /> : <TaskProjectChip task={task} />}
        <span>{task.key}</span>
        {task.priority !== 0 && (
          <span className="pr">
            <PriorityGlyph priority={task.priority} />
          </span>
        )}
      </div>
      <div className="tt">{task.title || "Untitled"}</div>
      {footer}
    </>
  )
}
