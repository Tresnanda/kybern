// The dock's Notes and Tasks panes: which project they list, which notes and tasks
// they show, and the row classes they share. Rows reuse the sidebar row tokens so
// the dock reads like the rest of the app's navigation.
import { useEffect, useState } from "react"

import {
  SIDEBAR_ROW_FOCUS_CLASS_NAME,
  SIDEBAR_ROW_GAP_CLASS_NAME,
  SIDEBAR_ROW_HEIGHT_CLASS_NAME,
  SIDEBAR_ROW_HOVER_CLASS_NAME,
  SIDEBAR_ROW_LABEL_TEXT_CLASS_NAME,
  SIDEBAR_ROW_RADIUS_CLASS_NAME,
  SIDEBAR_ROW_TEXT_CLASS_NAME,
} from "@/lib/kit/sidebarRowStyles"
import { cn } from "@/lib/utils"
import { isFreeChatProject, type NoteId, type NoteSummary, type ProjectId, type TaskItem, type TaskItemId, type TaskStatus, type ThreadId } from "@/protocol"
import { isEmptyThreadNote } from "@/state/notesModel"
import { useStore } from "@/state/store"
import { isOpenStatus, sortTasks } from "@/state/tasksModel"

/** Rows a dock list shows before "Show all"; keeps the pane cheap in a long project. */
export const DOCK_ROW_LIMIT = 50
/** Pinned notes shown above Recent. */
export const DOCK_PINNED_LIMIT = 8

/** One-line rows: tasks. */
export const DOCK_ROW_CLASS = cn(
  "flex w-full min-w-0 cursor-pointer items-center px-2 text-left select-none",
  SIDEBAR_ROW_HEIGHT_CLASS_NAME,
  SIDEBAR_ROW_GAP_CLASS_NAME,
  SIDEBAR_ROW_RADIUS_CLASS_NAME,
  SIDEBAR_ROW_TEXT_CLASS_NAME,
  SIDEBAR_ROW_FOCUS_CLASS_NAME,
  SIDEBAR_ROW_HOVER_CLASS_NAME,
  SIDEBAR_ROW_LABEL_TEXT_CLASS_NAME,
)

/** Two-line rows: notes (title and time, then the preview). */
export const DOCK_TWO_LINE_ROW_CLASS = cn(
  "flex w-full min-w-0 cursor-pointer flex-col gap-0.5 px-2 py-1.5 text-left select-none",
  SIDEBAR_ROW_RADIUS_CLASS_NAME,
  SIDEBAR_ROW_TEXT_CLASS_NAME,
  SIDEBAR_ROW_FOCUS_CLASS_NAME,
  SIDEBAR_ROW_HOVER_CLASS_NAME,
  SIDEBAR_ROW_LABEL_TEXT_CLASS_NAME,
)

export const DOCK_META_CLASS = "shrink-0 text-[length:var(--app-font-size-ui-sm,11px)] tabular-nums text-muted-foreground/55"

/** The project a dock pane lists: the open thread's, else the draft's; null means Global. */
export function useDockProjectId(threadId: ThreadId | null): ProjectId | null {
  return useStore((s) => {
    const id = threadId ? s.threads[threadId]?.project_id : s.selected.kind === "draft" ? s.selected.draft.projectId : undefined
    return id && !isFreeChatProject(id) && s.projects[id] ? id : null
  })
}

/** Mount a pane the first time it is shown, then keep it while its tab stays open. */
export function useShownOnce(active: boolean): boolean {
  const [shown, setShown] = useState(active)
  if (active && !shown) setShown(true)
  return shown
}

/** The current time, refreshed each minute while the pane is visible, for relative times. */
export function useMinuteNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

// ---- notes ----

const byRecent = (a: NoteSummary, b: NoteSummary) => b.updated_at.localeCompare(a.updated_at)

/**
 * The notes a dock pane lists for a project (or Global): pinned ones in scope plus
 * pinned Global notes, then the rest of the scope's notes, newest first. The open
 * thread's own note is shown above the lists, so it is left out of them.
 */
export function dockNotes(notes: readonly NoteSummary[], projectId: ProjectId | null, threadNoteId: NoteId | null): { pinned: NoteSummary[]; recent: NoteSummary[] } {
  const inScope = (note: NoteSummary) => (projectId ? note.scope !== "global" && note.project_id === projectId : note.scope === "global")
  const live = notes.filter((note) => !note.deleted_at && !isEmptyThreadNote(note) && note.id !== threadNoteId)
  return {
    pinned: live.filter((note) => note.pinned && (inScope(note) || note.scope === "global")).sort(byRecent),
    recent: live.filter((note) => !note.pinned && inScope(note)).sort(byRecent),
  }
}

// ---- tasks ----

/** The task whose run the thread is, if any. */
export function taskForRunThread(tasks: Readonly<Record<TaskItemId, TaskItem>>, threadId: ThreadId): TaskItem | undefined {
  for (const task of Object.values(tasks)) if (task.runs.some((run) => run.thread_id === threadId)) return task
  return undefined
}

/** A project's (or Global's) open tasks, grouped by status: running, needs review, to do, inbox. */
export function dockTaskGroups(tasks: Readonly<Record<TaskItemId, TaskItem>>, projectId: ProjectId | null): { status: TaskStatus; tasks: TaskItem[] }[] {
  const open = Object.values(tasks).filter(
    (task) => isOpenStatus(task.status) && (projectId ? task.scope === "project" && task.project_id === projectId : task.scope === "global"),
  )
  const groups: { status: TaskStatus; tasks: TaskItem[] }[] = []
  for (const task of sortTasks(open, "manual", false)) {
    const last = groups[groups.length - 1]
    if (last?.status === task.status) last.tasks.push(task)
    else groups.push({ status: task.status, tasks: [task] })
  }
  return groups
}
