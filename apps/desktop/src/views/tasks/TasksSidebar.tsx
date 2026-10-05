// The Tasks panel: the thread panel's replacement while the Tasks page is open.
// A header with New task, search, the status views with counts, Global, then every
// project with its dot (empty ones too, so a project can be chosen before it has
// tasks) and a hover "+" to add one, and a quiet line about agents at work.
// Projects pin to the top from their context menu. Collapsing the Projects heading
// keeps the pinned ones and the one being viewed; both choices are kept per environment.
import { useMemo, type ComponentProps, type ReactNode } from "react"

import { DisclosureChevron } from "@/components/kit/DisclosureChevron"
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/kit/tooltip"
import { ContextMenu, ContextMenuContent, ContextMenuGroup, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu"
import { useNow } from "@/lib/hooks"
import { DISCLOSURE_INNER_CLASS, disclosureShellClassName } from "@/lib/kit/disclosureMotion"
import { AddPlusIcon, ListChecksIcon, NewThreadIcon, PinFilledIcon, PinIcon, SearchIcon } from "@/lib/kit/icons"
import { cn } from "@/lib/utils"
import type { ProjectId } from "@/protocol"
import { setProjectPinned, setProjectsCollapsed, setTaskFilter, setTaskQuery, useAllTasks, useTasks } from "@/state/tasks"
import { arrangeTaskProjects, countTasks, filterProjectId, type TaskFilter } from "@/state/tasksModel"
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
  const pinned = useTasks((s) => s.prefs.pinnedProjects)
  const collapsed = useTasks((s) => s.prefs.projectsCollapsed)
  const rows = useMemo(() => arrangeTaskProjects(projects, pinned, collapsed, filterProjectId(filter)), [projects, pinned, collapsed, filter])
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
        <div className="tk-nav-global">
          <NavRow current={current("global")} onClick={() => choose("global")} glyph={<ProjectDot projectId={null} />} label="Global" count={counts.global} />
        </div>
        <div className="tk-nav-label" data-empty={projects.length === 0 || undefined}>
          {projects.length > 0 ? (
            <button
              type="button"
              id="tk-projects-label"
              className="tk-nav-disclose"
              aria-expanded={!collapsed}
              aria-controls="tk-projects"
              onClick={() => setProjectsCollapsed(!collapsed)}
            >
              Projects
              <DisclosureChevron open={!collapsed} className="size-3 text-current" />
            </button>
          ) : (
            <span id="tk-projects-label">Projects</span>
          )}
          <Tooltip>
            <TooltipTrigger render={<button type="button" className="tk-nav-add" aria-label="Add project" onClick={addProject.add} />}>
              <AddPlusIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="right">Add project</TooltipPopup>
          </Tooltip>
        </div>
        <div role="group" id="tk-projects" aria-labelledby="tk-projects-label">
          {rows.map(({ project, pinned: isPinned, visible }) => (
            // Each row folds on its own, so the pinned and current ones stay where they are.
            <div key={project.id} className={disclosureShellClassName(visible)} inert={!visible || undefined}>
              <div className={DISCLOSURE_INNER_CLASS}>
                <ProjectRow
                  projectId={project.id}
                  pinned={isPinned}
                  current={current(`project:${project.id}`)}
                  onClick={() => choose(`project:${project.id}`)}
                  label={project.name}
                  count={counts.projects[project.id] ?? 0}
                />
              </div>
            </div>
          ))}
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

function NavRow({ current, glyph, label, count, trailing, className, ...button }: ComponentProps<"button"> & { current: boolean; glyph: ReactNode; label: string; count: number; trailing?: ReactNode }) {
  return (
    <button type="button" aria-current={current || undefined} {...button} className={cn("tk-nav-row", className)}>
      <span className="g">{glyph}</span>
      <span className="l">{label}</span>
      {trailing}
      <span className="count">{count}</span>
    </button>
  )
}

function ProjectRow({ projectId, pinned, current, onClick, label, count }: { projectId: ProjectId; pinned: boolean; current: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <NavRow
            current={current}
            onClick={onClick}
            glyph={<ProjectDot projectId={projectId} />}
            label={label}
            count={count}
            trailing={
              pinned ? (
                <>
                  <PinFilledIcon className="pin size-3" aria-hidden />
                  <span className="sr-only">Pinned</span>
                </>
              ) : undefined
            }
          />
        }
      />
      <ContextMenuContent className="w-44 min-w-44">
        <ContextMenuGroup>
          <ContextMenuItem onClick={() => setProjectPinned(projectId, !pinned)}>
            {pinned ? <PinFilledIcon /> : <PinIcon />}
            {pinned ? "Unpin" : "Pin"}
          </ContextMenuItem>
        </ContextMenuGroup>
      </ContextMenuContent>
    </ContextMenu>
  )
}
