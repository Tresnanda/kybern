// The list view: tasks grouped (by status unless Display says otherwise), one 40px row
// each. Rows carry priority, key, status, title, what the agent is doing (or what it
// changed), project and age. Status groups reorder and move by drag.
import { DndContext, DragOverlay, useDroppable } from "@dnd-kit/core"
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { memo, useMemo, useState, type CSSProperties } from "react"
import { useReducedMotion } from "motion/react"

import { relativeTime } from "@/lib/format"
import { AddPlusIcon, ChevronRightIcon } from "@/lib/kit/icons"
import type { ProjectId, TaskItem, TaskItemId, TaskStatus } from "@/protocol"
import { openTask, setFocusedTask, setGroupCollapsed, startQuickAdd, useTasks } from "@/state/tasks"
import { isGroupCollapsed, isOpenStatus, LIST_STATUS_ORDER, latestRun, runChanges, runDuration, runOutcome, shortDuration, STATUS_LABEL, type TaskGroup } from "@/state/tasksModel"
import { useStore } from "@/state/store"
import { ProjectDot } from "@/lib/kit/projectDot"
import { AgentMark, PriorityGlyph, TaskStatusGlyph } from "./TaskGlyphs"
import { QuickAddRow } from "./QuickAdd"
import { projectForNewTask } from "./taskActions"
import { TaskProjectChip } from "./TaskMenus"
import { containerId, useTaskDnd } from "./useTaskDnd"

/** Rows a closed-work group shows before "Show more"; keeps a long history cheap. */
const CLOSED_ROW_LIMIT = 50

export function TaskList({ groups, tasks, now }: { groups: TaskGroup[]; tasks: Record<TaskItemId, TaskItem>; now: number }) {
  const prefs = useTasks((s) => s.prefs)
  const quickAdd = useTasks((s) => s.quickAdd)
  const focusedId = useTasks((s) => s.focusedId)
  const projects = useStore((s) => s.projects)
  const reducedMotion = useReducedMotion()
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  // A quick-add row needs its group even when that group is empty.
  const shown = useMemo(() => {
    if (!quickAdd || groups.some((group) => group.key === quickAdd.groupKey)) return groups
    const status = quickAdd.groupKey.startsWith("status:") ? (quickAdd.groupKey.slice(7) as TaskStatus) : undefined
    const empty: TaskGroup = { key: quickAdd.groupKey, label: status ? STATUS_LABEL[status] : "New task", status, tasks: [] }
    if (!status) return [empty, ...groups]
    const at = groups.findIndex((group) => group.status && LIST_STATUS_ORDER.indexOf(group.status) > LIST_STATUS_ORDER.indexOf(status))
    return at < 0 ? [...groups, empty] : [...groups.slice(0, at), empty, ...groups.slice(at)]
  }, [groups, quickAdd])

  const draggable = prefs.grouping === "status"
  const containers = useMemo(() => {
    const map: Record<string, TaskItemId[]> = {}
    if (!draggable) return map
    for (const group of shown) if (group.status) map[containerId(group.status)] = group.tasks.map((task) => task.id)
    return map
  }, [shown, draggable])
  const dnd = useTaskDnd(containers, tasks, prefs.ordering === "manual")
  const active = dnd.activeId ? tasks[dnd.activeId] : undefined

  const projectName = (id: ProjectId | null | undefined) => (id ? projects[id]?.name ?? "Project" : "Global")

  const body = (
    <div className="tk-list" role="list" aria-label="Tasks">
      {shown.map((group) => {
        const collapsed = isGroupCollapsed(prefs, group) && quickAdd?.groupKey !== group.key
        const container = group.status && draggable ? containerId(group.status) : null
        const ids = container ? dnd.items[container] ?? [] : group.tasks.map((task) => task.id)
        const limit = group.status && !isOpenStatus(group.status) && !expanded[group.key] ? CLOSED_ROW_LIMIT : Infinity
        const rows = ids.slice(0, limit)
        return (
          <section key={group.key} className="tk-section" aria-label={group.label}>
            <GroupHeader group={group} count={group.tasks.length} collapsed={collapsed} />
            {!collapsed && (
              <GroupBody container={container}>
                {quickAdd?.groupKey === group.key && <QuickAddRow key={quickAdd.nonce} request={quickAdd} variant="row" />}
                <SortableContext items={container ? rows : []} strategy={verticalListSortingStrategy} disabled={!container}>
                  {rows.map((id) => {
                    const task = tasks[id]
                    if (!task) return null
                    return (
                      <TaskRow
                        key={id}
                        task={task}
                        now={now}
                        focused={focusedId === id}
                        projectName={projectName(task.scope === "project" ? task.project_id : null)}
                        sortable={!!container}
                      />
                    )
                  })}
                </SortableContext>
                {ids.length > rows.length && (
                  <button type="button" className="tk-more" onClick={() => setExpanded((state) => ({ ...state, [group.key]: true }))}>
                    Show {ids.length - rows.length} more
                  </button>
                )}
              </GroupBody>
            )}
          </section>
        )
      })}
    </div>
  )

  if (!draggable) return body
  return (
    <DndContext
      sensors={dnd.sensors}
      collisionDetection={dnd.collision}
      onDragStart={dnd.onDragStart}
      onDragOver={dnd.onDragOver}
      onDragEnd={dnd.onDragEnd}
      onDragCancel={dnd.onDragCancel}
      accessibility={{ screenReaderInstructions: { draggable: "Press S to change status. Drag with a pointer to reorder." } }}
    >
      {body}
      <DragOverlay dropAnimation={reducedMotion ? null : undefined}>
        {active ? (
          <div className="tk-row" data-focused style={{ background: "var(--task-card-hover)", boxShadow: "var(--task-shadow-card-hover)", borderRadius: 8 }}>
            <RowCells task={active} now={now} projectName={projectName(active.scope === "project" ? active.project_id : null)} overlay />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}

function GroupBody({ container, children }: { container: string | null; children: React.ReactNode }) {
  const { setNodeRef } = useDroppable({ id: container ?? "none", disabled: !container })
  return (
    <div ref={container ? setNodeRef : undefined} role="presentation">
      {children}
    </div>
  )
}

function GroupHeader({ group, count, collapsed }: { group: TaskGroup; count: number; collapsed: boolean }) {
  const add = () =>
    startQuickAdd({
      groupKey: group.key,
      status: group.status === "todo" ? "todo" : "inbox",
      projectId: group.projectId !== undefined ? group.projectId : projectForNewTask(),
      priority: group.priority,
    })
  const canAdd = !group.status || group.status === "inbox" || group.status === "todo"
  return (
    <div className="tk-group">
      <button type="button" className="tk-group-toggle" aria-expanded={!collapsed} onClick={() => setGroupCollapsed(group.key, !collapsed)}>
        <span className="gst">
          {group.status ? (
            <TaskStatusGlyph status={group.status} animated />
          ) : group.priority !== undefined ? (
            <span className="flex text-[var(--task-fg2)]">
              <PriorityGlyph priority={group.priority} />
            </span>
          ) : (
            <span className="flex size-3.5 items-center justify-center">
              <ProjectDot projectId={group.projectId ?? null} />
            </span>
          )}
        </span>
        <span>{group.label}</span>
        <span className="count">{count}</span>
        {collapsed && <ChevronRightIcon className="chev size-3" aria-hidden />}
      </button>
      {canAdd && (
        <button type="button" className="tk-btn add" aria-label={`New task in ${group.label}`} onClick={add}>
          <AddPlusIcon className="size-3.5" />
        </button>
      )}
    </div>
  )
}

const TaskRow = memo(function TaskRow({ task, now, focused, projectName, sortable }: { task: TaskItem; now: number; focused: boolean; projectName: string; sortable: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id, disabled: !sortable })
  const style: CSSProperties | undefined = sortable ? { transform: CSS.Translate.toString(transform), transition } : undefined
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...(sortable ? listeners : {})}
      {...(sortable ? { "aria-roledescription": attributes["aria-roledescription"], "aria-describedby": attributes["aria-describedby"] } : {})}
      role="listitem"
      tabIndex={focused ? 0 : -1}
      data-task-row={task.id}
      data-focused={focused || undefined}
      data-closed={!isOpenStatus(task.status) || undefined}
      data-dragging={isDragging || undefined}
      className="tk-row"
      aria-label={`${task.key} ${task.title || "Untitled"}, ${STATUS_LABEL[task.status]}`}
      onFocus={() => setFocusedTask(task.id)}
      onClick={() => openTask(task.id)}
    >
      <RowCells task={task} now={now} projectName={projectName} />
    </div>
  )
})

function RowCells({ task, now, projectName, overlay }: { task: TaskItem; now: number; projectName: string; overlay?: boolean }) {
  const run = latestRun(task)
  const changes = run ? runChanges(run) : null
  let detail: React.ReactNode = null
  if (run && task.status === "running") {
    detail = (
      <>
        <span className="mk">
          <AgentMark kind={run.provider.kind} />
        </span>
        <span className="live">{run.state === "waiting" ? "Waiting for you" : run.activity || "Working"}</span>
        <span className="tk-num">· {shortDuration(runDuration(run, now))}</span>
      </>
    )
  } else if (run && task.status === "needs_review") {
    detail = (
      <>
        <span className="mk">
          <AgentMark kind={run.provider.kind} />
        </span>
        {changes ? (
          <>
            <span className="tk-num">
              +{changes.added} −{changes.removed}
            </span>
            <span>
              in {changes.files} {changes.files === 1 ? "file" : "files"}
            </span>
          </>
        ) : (
          <span>{runOutcome(run, now)}</span>
        )}
      </>
    )
  }
  return (
    <>
      <span className="pr">
        <PriorityGlyph priority={task.priority} />
      </span>
      <span className="key">{task.key}</span>
      <span className="st">
        <TaskStatusGlyph status={task.status} animated />
      </span>
      <span className="t">{task.title || "Untitled"}</span>
      <span className="det">{detail}</span>
      <span className="proj">
        {overlay ? (
          <>
            <ProjectDot projectId={task.scope === "project" ? task.project_id : null} />
            <span>{projectName}</span>
          </>
        ) : (
          <TaskProjectChip task={task} showName />
        )}
      </span>
      <span className="age">{relativeTime(task.created_at, now)}</span>
    </>
  )
}
