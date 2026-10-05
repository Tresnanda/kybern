// The dock's Tasks pane: the task this thread is a run of, then the project's (or
// Global's) open tasks by status, most urgent first, with an inline add row. A row
// opens the task's page.
import { memo, useMemo, useRef, useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/kit/button"
import { IconButton } from "@/components/kit/icon-button"
import { ListChecksIcon, PlusIcon } from "@/lib/kit/icons"
import { ChecklistRing } from "@/lib/kit/projectDot"
import type { ProjectId, TaskItem, ThreadId } from "@/protocol"
import { errorText } from "@/state/rpc"
import { useStore } from "@/state/store"
import { createTask, openTask, openTasks, refreshTasks, useTasks } from "@/state/tasks"
import { isLiveRun, PRIORITY_LABEL, shortActivity, splitTaskBody, STATUS_LABEL } from "@/state/tasksModel"
import { CreatedByThread } from "../tasks/CreatedBy"
import { PriorityGlyph, TaskStatusGlyph } from "../tasks/TaskGlyphs"
import { DOCK_HEADER_ICON_BUTTON_CLASS } from "../chrome"
import { DockEmpty, DockFooterLink, DockHint, DockScopeHeader, DockSectionLabel } from "./DockParts"
import { DOCK_META_CLASS, DOCK_ROW_CLASS, DOCK_ROW_LIMIT, dockTaskGroups, taskForRunThread, useDockProjectId, useShownOnce } from "./dockModel"

export function TasksDockPanel({ threadId, active }: { threadId: ThreadId | null; active: boolean }) {
  const shown = useShownOnce(active)
  if (!shown) return null
  return <TasksDockContent threadId={threadId} />
}

const TasksDockContent = memo(function TasksDockContent({ threadId }: { threadId: ThreadId | null }) {
  const projectId = useDockProjectId(threadId)
  const projectName = useStore((s) => (projectId ? s.projects[projectId]?.name : undefined))
  const tasks = useTasks((s) => s.tasks)
  const loaded = useTasks((s) => s.loaded)
  const supported = useTasks((s) => s.supported)
  const error = useTasks((s) => s.error)
  const runTask = useTasks((s) => (threadId ? taskForRunThread(s.tasks, threadId) : undefined))
  const groups = useMemo(() => dockTaskGroups(tasks, projectId), [tasks, projectId])
  const [adding, setAdding] = useState(false)
  const where = projectId ? projectName ?? "this project" : "Global"

  const total = groups.reduce((sum, group) => sum + group.tasks.length, 0)
  const shownGroups = useMemo(() => capGroups(groups, DOCK_ROW_LIMIT), [groups])

  const addButton = (
    <IconButton variant="chrome" size="icon-xs" className={DOCK_HEADER_ICON_BUTTON_CLASS} label="New task" tooltip="New task" tooltipSide="bottom" onClick={() => setAdding(true)}>
      <PlusIcon />
    </IconButton>
  )

  let lists: React.ReactNode
  if (!supported || (error && !loaded)) {
    lists = threadId && runTask ? (
      <DockHint>{error ?? "Unable to load tasks."}</DockHint>
    ) : (
      <DockEmpty icon={<ListChecksIcon className="size-4" />} title="Unable to load tasks" body={error ?? "Check the connection and try again."} action={supported ? <Button size="xs" variant="outline" onClick={refreshTasks}>Try again</Button> : undefined} />
    )
  } else if (!loaded) {
    lists = null
  } else if (total === 0 && !adding) {
    lists = runTask ? (
      <DockHint>Open tasks for {where} appear here.</DockHint>
    ) : (
      <DockEmpty
        icon={<ListChecksIcon className="size-4" />}
        title="No open tasks"
        body={`Tasks for ${where} appear here.`}
        action={<Button size="xs" variant="outline" onClick={() => setAdding(true)}>New task</Button>}
      />
    )
  } else {
    lists = (
      <>
        {adding && (
          <div className="px-1.5 pb-1">
            <DockQuickAdd projectId={projectId} onDone={() => setAdding(false)} />
          </div>
        )}
        {shownGroups.map((group, index) => (
          <section key={group.status} aria-label={STATUS_LABEL[group.status]} className={index > 0 ? "mt-2" : undefined}>
            <DockSectionLabel label={STATUS_LABEL[group.status]} count={group.tasks.length} />
            <div className="flex flex-col gap-px px-1.5">
              {group.rows.map((task) => <TaskRow key={task.id} task={task} />)}
            </div>
          </section>
        ))}
        {total > 0 && <DockFooterLink label={total > DOCK_ROW_LIMIT ? `Show all ${total} in Tasks` : "Show all in Tasks"} onClick={() => openTasks(projectId ? `project:${projectId}` : "global")} />}
      </>
    )
  }

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col font-system-ui">
      <DockScopeHeader projectId={projectId} action={addButton} />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-1">
        {runTask && (
          <section aria-label="This thread’s task" className="mb-2">
            <DockSectionLabel label="This thread" />
            <RunTaskCard task={runTask} threadId={threadId!} />
          </section>
        )}
        {lists}
      </div>
    </div>
  )
})

/** The groups' first `limit` rows, in order; groups left with no rows are dropped. */
function capGroups<T extends { tasks: TaskItem[] }>(groups: T[], limit: number): (T & { rows: TaskItem[] })[] {
  const shown: (T & { rows: TaskItem[] })[] = []
  let left = limit
  for (const group of groups) {
    if (left <= 0) break
    const rows = group.tasks.slice(0, left)
    left -= rows.length
    shown.push({ ...group, rows })
  }
  return shown
}

/** The task this thread is a run of: key, status, title, checklist progress, and a way to its page. */
const RunTaskCard = memo(function RunTaskCard({ task, threadId }: { task: TaskItem; threadId: ThreadId }) {
  const criteria = useMemo(() => splitTaskBody(task.body).criteria, [task.body])
  const done = criteria.filter((criterion) => criterion.checked).length
  const run = task.runs.find((candidate) => candidate.thread_id === threadId)
  const activity = run && isLiveRun(run) && run.activity ? shortActivity(run.activity) : null
  return (
    <div className="mx-2 rounded-lg bg-[var(--color-background-elevated-secondary)] px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-1.5 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/70">
        <TaskStatusGlyph status={task.status} size={12} animated />
        <span className="shrink-0 tabular-nums">{task.key}</span>
        <span aria-hidden>·</span>
        <span className="min-w-0 truncate">{STATUS_LABEL[task.status]}</span>
        {run && task.runs.length > 1 && <span className="ml-auto shrink-0 tabular-nums text-muted-foreground/50">Run {run.number}</span>}
      </div>
      <p className="mt-1 line-clamp-2 text-[length:var(--app-font-size-ui,12px)] leading-snug font-medium text-pretty text-foreground/90">{task.title.trim() || "Untitled"}</p>
      {activity && <p title={run?.activity ?? undefined} className="mt-1 truncate text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/60">{activity}</p>}
      <div className="mt-2 flex items-center gap-2">
        {criteria.length > 0 && (
          <span className="flex min-w-0 items-center gap-1.5 text-[length:var(--app-font-size-ui-sm,11px)] tabular-nums text-muted-foreground/65">
            <ChecklistRing done={done} total={criteria.length} />
            {done} of {criteria.length} done
          </span>
        )}
        <Button size="xs" variant="outline" className="ml-auto shrink-0" onClick={() => openTask(task.id)}>Open task</Button>
      </div>
    </div>
  )
})

const TaskRow = memo(function TaskRow({ task }: { task: TaskItem }) {
  const title = task.title.trim() || "Untitled"
  return (
    <button type="button" className={DOCK_ROW_CLASS} onClick={() => openTask(task.id)} title={title} aria-label={`${task.key} ${title}, ${STATUS_LABEL[task.status]}${task.priority ? `, ${PRIORITY_LABEL[task.priority]}` : ""}`}>
      <TaskStatusGlyph status={task.status} animated />
      <span className={DOCK_META_CLASS}>{task.key}</span>
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {task.created_by_thread && <CreatedByThread threadId={task.created_by_thread} variant="glyph" interactive={false} className="text-muted-foreground/55" />}
      {task.priority !== 0 && <PriorityGlyph priority={task.priority} className="text-muted-foreground/70" />}
    </button>
  )
})

/**
 * Inline add: Return adds the task and keeps the field for the next one, ⌘Return adds
 * and opens it, Escape cancels, and leaving the field adds what was typed.
 */
function DockQuickAdd({ projectId, onDone }: { projectId: ProjectId | null; onDone: () => void }) {
  const [title, setTitle] = useState("")
  const field = useRef<HTMLInputElement>(null)
  const canceled = useRef(false)
  // A ref, not state: Return and the blur that may follow must not both add the task.
  const busy = useRef(false)

  const commit = async (text: string, after: "keep" | "close" | "open") => {
    if (!text.trim()) {
      if (after !== "keep") onDone()
      return
    }
    if (busy.current) return
    busy.current = true
    // Clear the field at once so the next title can be typed while this one saves.
    setTitle("")
    try {
      const task = await createTask({ scope: projectId ? "project" : "global", project_id: projectId, title: text.trim(), status: "inbox" })
      if (after === "open") openTask(task.id)
      if (after !== "keep") onDone()
    } catch (error) {
      setTitle((current) => current || text)
      toast.error("Unable to add the task", { description: errorText(error) })
    } finally {
      busy.current = false
    }
  }

  return (
    <div className="flex h-[var(--app-density-row-height,1.75rem)] min-w-0 items-center gap-[var(--app-density-row-gap,0.5rem)] rounded-md bg-[var(--color-background-elevated-secondary)] px-2">
      <TaskStatusGlyph status="inbox" />
      <input
        ref={field}
        autoFocus
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return
          if (event.key === "Enter") {
            event.preventDefault()
            void commit(title, event.metaKey || event.ctrlKey ? "open" : "keep")
          } else if (event.key === "Escape") {
            event.preventDefault()
            event.stopPropagation()
            canceled.current = true
            onDone()
          }
        }}
        onBlur={() => {
          if (canceled.current || busy.current) return
          void commit(title, "close")
        }}
        placeholder="Task title"
        aria-label="New task title"
        className="min-w-0 flex-1 bg-transparent text-[length:var(--app-font-size-ui,12px)] text-foreground outline-none placeholder:text-muted-foreground/50"
      />
    </div>
  )
}
