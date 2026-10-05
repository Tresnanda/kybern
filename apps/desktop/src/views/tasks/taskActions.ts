// Small commands the Tasks surfaces share: where a new task goes, and starting one.
import type { ProjectId, TaskStatus } from "@/protocol"
import { contextProjectIdOf } from "@/state/notes"
import { createAndOpenTask, getTask, openTask, startQuickAdd, useTasks } from "@/state/tasks"
import { filterProjectId } from "@/state/tasksModel"
import { useStore } from "@/state/store"

/** The project a new task belongs to: the filtered project, else the one you came from. */
export function projectForNewTask(): ProjectId | null {
  const filter = useTasks.getState().prefs.filter
  if (filter === "global") return null
  const filtered = filterProjectId(filter)
  if (filtered) return filtered
  const state = useStore.getState()
  const context = contextProjectIdOf(state)
  return context && state.projects[context] ? context : null
}

/** The quick-add row's group for a status in the current grouping. */
export function quickAddGroupKey(status: TaskStatus, projectId: ProjectId | null): string {
  const { grouping, view } = useTasks.getState().prefs
  if (view === "board" || grouping === "status") return `status:${status}`
  if (grouping === "project") return `project:${projectId ?? "global"}`
  return "priority:0"
}

/**
 * "New task" (C, the panel's button, ⌘N on the page): a quick-add row in the list or
 * board; on a task's page, a new task opened with its title ready for typing.
 */
export function newTaskHere(status: TaskStatus = "inbox") {
  const state = useStore.getState()
  const selected = state.selected
  const projectId = projectForNewTask()
  if (selected.kind === "tasks" && selected.taskId) {
    const open = getTask(selected.taskId)
    const home = open ? (open.scope === "project" ? open.project_id ?? null : null) : projectId
    void createAndOpenTask({ projectId: home, status: "inbox" })
    return
  }
  if (selected.kind !== "tasks") openTask()
  startQuickAdd({ groupKey: quickAddGroupKey(status, projectId), status, projectId })
}
