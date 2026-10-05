// The Tasks panel: the thread panel's replacement while the Tasks page is open.
// A header with New task, search, the status views with counts, every project with
// its dot (empty ones too, so a project can be chosen before it has tasks) and a
// hover "+" to add one, and a quiet line about agents at work.
import { useMemo, type ReactNode } from "react"

import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/kit/tooltip"
import { useNow } from "@/lib/hooks"
import { AddPlusIcon, ListChecksIcon, NewThreadIcon, SearchIcon } from "@/lib/kit/icons"
import { setTaskFilter, setTaskQuery, useAllTasks, useTasks } from "@/state/tasks"
import { countTasks, type TaskFilter } from "@/state/tasksModel"
import { useStore } from "@/state/store"
import { ProjectDot } from "@/lib/kit/projectDot"
import { useAddProject } from "../useAddProject"
import { TaskStatusGlyph } from "./TaskGlyphs"
import { newTaskHere, useTaskProjects } from "./taskActions"

export function TasksSidebar() {
  const tasks = useAllTasks()
  const filter = useTasks((s) => s.prefs.filter)
  const query = useTasks((s) => s.query)
  const projects = useTaskProjects()
  const openTaskId = useStore((s) => (s.selected.kind === "tasks" ? s.selected.taskId : undefined))
  const now = useNow(60_000)
  const counts = useMemo(() => countTasks(tasks, now), [tasks, now])

  const choose = (next: TaskFilter) => {
    setTaskFilter(next)
    // Choosing a view from a task page goes back to the list.
    if (openTaskId) useStore.getState().selectTasks()
  }
  const current = (value: TaskFilter) => !openTaskId && filter === value
  // A project added here opens its tasks.
  const addProject = useAddProject((project) => choose(`project:${project.id}`))

  return (
    <nav aria-label="Tasks" className="tk-panel font-system-ui">
      <div className="tk-panel-head">
        <h2>Tasks</h2>
        <span className="flex-1" />
        <Tooltip>
          <TooltipTrigger render={<button type="button" className="tk-btn" aria-label="New task" onClick={() => newTaskHere()} />}>
            <NewThreadIcon className="size-4" />
          </TooltipTrigger>
          <TooltipPopup side="bottom">New task · C</TooltipPopup>
        </Tooltip>
      </div>
      <label className="tk-search">
        <SearchIcon className="size-3.5 shrink-0" aria-hidden />
        <input
          value={query}
          onChange={(event) => setTaskQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && query) {
              event.preventDefault()
              setTaskQuery("")
            } else if (event.key === "Enter" || event.key === "ArrowDown") {
              event.preventDefault()
              document.querySelector<HTMLElement>("[data-task-row], [data-task-card]")?.focus()
            }
          }}
          placeholder="Search"
          aria-label="Search tasks"
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <div className="tk-nav">
        <NavRow current={current("all")} onClick={() => choose("all")} glyph={<ListChecksIcon className="size-4" />} label="All tasks" count={counts.all} />
        <NavRow current={current("inbox")} onClick={() => choose("inbox")} glyph={<TaskStatusGlyph status="inbox" mono />} label="Inbox" count={counts.inbox} />
        <NavRow current={current("running")} onClick={() => choose("running")} glyph={<TaskStatusGlyph status="running" mono />} label="Running" count={counts.running} />
        <NavRow current={current("needs_review")} onClick={() => choose("needs_review")} glyph={<TaskStatusGlyph status="needs_review" mono />} label="Needs review" count={counts.needs_review} />
        <NavRow current={current("done")} onClick={() => choose("done")} glyph={<TaskStatusGlyph status="done" mono />} label="Recently done" count={counts.done} />
        <div className="tk-nav-label" data-empty={projects.length === 0 || undefined}>
          <span id="tk-projects-label">Projects</span>
          <Tooltip>
            <TooltipTrigger render={<button type="button" className="tk-nav-add" aria-label="Add project" onClick={addProject.add} />}>
              <AddPlusIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="right">Add project</TooltipPopup>
          </Tooltip>
        </div>
        <div role="group" aria-labelledby="tk-projects-label">
          {projects.map((project) => (
            <NavRow
              key={project.id}
              current={current(`project:${project.id}`)}
              onClick={() => choose(`project:${project.id}`)}
              glyph={<ProjectDot projectId={project.id} />}
              label={project.name}
              count={counts.projects[project.id] ?? 0}
            />
          ))}
          <NavRow current={current("global")} onClick={() => choose("global")} glyph={<ProjectDot projectId={null} />} label="Global" count={counts.global} />
        </div>
      </div>
      {(counts.running > 0 || counts.needs_review > 0) && (
        <button type="button" className="tk-foot" onClick={() => choose(counts.running > 0 ? "running" : "needs_review")}>
          <span className="mt-0.5 flex">
            <TaskStatusGlyph status={counts.running > 0 ? "running" : "needs_review"} />
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="a">{counts.running > 0 ? (counts.running === 1 ? "1 agent running" : `${counts.running} agents running`) : `${counts.needs_review} waiting for review`}</span>
            {counts.running > 0 && counts.needs_review > 0 && <span className="b">{counts.needs_review} waiting for review</span>}
          </span>
        </button>
      )}
      {addProject.dialog}
    </nav>
  )
}

function NavRow({ current, onClick, glyph, label, count }: { current: boolean; onClick: () => void; glyph: ReactNode; label: string; count: number }) {
  return (
    <button type="button" className="tk-nav-row" aria-current={current || undefined} onClick={onClick}>
      <span className="g">{glyph}</span>
      <span className="l">{label}</span>
      <span className="count">{count}</span>
    </button>
  )
}
