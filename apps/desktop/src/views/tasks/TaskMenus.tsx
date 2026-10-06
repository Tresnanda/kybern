// Status, priority and project pickers for a task. Each opens from its own trigger,
// or, for the S and P shortcuts, anchored to the focused row with no trigger at all.
import type { ReactElement, ReactNode, SyntheticEvent } from "react"

import { ComposerPickerMenuPopup } from "@/components/kit/chat/ComposerPickerMenuPopup"
import { Menu, MenuGroup, MenuGroupLabel, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "@/components/kit/menu"
import type { ProjectId, TaskItem, TaskPriority, TaskStatus } from "@/protocol"
import { setTaskPriority, setTaskProject, setTaskStatus, setTasksPriority, setTasksStatus } from "@/state/tasks"
import { PRIORITY_LABEL, PRIORITY_MENU_ORDER, STATUS_LABEL, USER_STATUSES } from "@/state/tasksModel"
import { useStore } from "@/state/store"
import { ProjectDot } from "@/lib/kit/projectDot"
import { PriorityGlyph, TaskStatusGlyph } from "./TaskGlyphs"
import { useTaskProjects } from "./taskActions"

interface PickerProps {
  /** The element that opens the menu. Omit it to open from `anchor` while `open`. */
  trigger?: ReactElement
  open?: boolean
  onOpenChange?: (open: boolean) => void
  anchor?: Element | null
  align?: "start" | "center" | "end"
  side?: "top" | "bottom"
}

function Picker({
  trigger,
  open,
  onOpenChange,
  anchor,
  align = "start",
  side = "bottom",
  label,
  value,
  onValue,
  children,
}: PickerProps & { label: string; value: string; onValue: (value: string) => void; children: ReactNode }) {
  return (
    <Menu open={open} onOpenChange={onOpenChange ? (next) => onOpenChange(next) : undefined}>
      {trigger && <MenuTrigger render={trigger} />}
      <ComposerPickerMenuPopup align={align} side={side} anchor={trigger ? undefined : anchor} className="min-w-48">
        <MenuGroup>
          <MenuGroupLabel>{label}</MenuGroupLabel>
          <MenuRadioGroup value={value} onValueChange={(next) => onValue(next as string)}>
            {children}
          </MenuRadioGroup>
        </MenuGroup>
      </ComposerPickerMenuPopup>
    </Menu>
  )
}

/** The task's value when every task shares it; "" (nothing checked) when they differ. */
function shared<T extends string | number>(tasks: readonly TaskItem[], read: (task: TaskItem) => T): string {
  const first = tasks[0]
  if (!first) return ""
  const value = read(first)
  return tasks.every((task) => read(task) === value) ? String(value) : ""
}

/** One task, or several (the selection bar): choosing applies to all of them. */
type Target = { task: TaskItem; tasks?: undefined } | { tasks: readonly TaskItem[]; task?: undefined }
const targets = (target: Target): readonly TaskItem[] => target.tasks ?? [target.task]

export function TaskStatusMenu({ task, tasks, ...props }: PickerProps & Target) {
  const list = targets({ task, tasks } as Target)
  const many = !!tasks
  return (
    <Picker
      {...props}
      label="Status"
      value={shared(list, (item) => item.status)}
      onValue={(value) => {
        if (many) void setTasksStatus(list.map((item) => item.id), value as TaskStatus)
        else if (value !== task!.status) void setTaskStatus(task!.id, value as TaskStatus)
      }}
    >
      {USER_STATUSES.map((status) => (
        <MenuRadioItem closeOnClick key={status} value={status}>
          <TaskStatusGlyph status={status} />
          {STATUS_LABEL[status]}
        </MenuRadioItem>
      ))}
    </Picker>
  )
}

export function TaskPriorityMenu({ task, tasks, ...props }: PickerProps & Target) {
  const list = targets({ task, tasks } as Target)
  const many = !!tasks
  return (
    <Picker
      {...props}
      label="Priority"
      value={shared(list, (item) => item.priority)}
      onValue={(value) => {
        if (many) void setTasksPriority(list.map((item) => item.id), Number(value) as TaskPriority)
        else if (Number(value) !== task!.priority) void setTaskPriority(task!.id, Number(value) as TaskPriority)
      }}
    >
      {PRIORITY_MENU_ORDER.map((priority) => (
        <MenuRadioItem closeOnClick key={priority} value={String(priority)}>
          <span className="flex text-[var(--task-fg2)]">
            <PriorityGlyph priority={priority} />
          </span>
          {PRIORITY_LABEL[priority]}
        </MenuRadioItem>
      ))}
    </Picker>
  )
}

export function TaskProjectMenu({ task, ...props }: PickerProps & { task: TaskItem }) {
  const list = useTaskProjects()
  const current = task.scope === "project" && task.project_id ? task.project_id : "global"
  return (
    <Picker
      {...props}
      label="Project"
      value={current}
      onValue={(value) => value !== current && void setTaskProject(task.id, value === "global" ? null : (value as ProjectId))}
    >
      <MenuRadioItem closeOnClick value="global">
        <ProjectDot projectId={null} />
        Global
      </MenuRadioItem>
      {list.map((project) => (
        <MenuRadioItem closeOnClick key={project.id} value={project.id}>
          <ProjectDot projectId={project.id} />
          <span className="min-w-0 truncate">{project.name}</span>
        </MenuRadioItem>
      ))}
    </Picker>
  )
}

const stop = (event: SyntheticEvent) => event.stopPropagation()

/**
 * The project on a list row or board card: its dot (and, on rows, its name), opening
 * the project picker in place. Clicks, drags and keys stay here, including those from
 * the portaled menu, so choosing a project never opens or drags the task.
 */
export function TaskProjectChip({ task, showName }: { task: TaskItem; showName?: boolean }) {
  const projectId = task.scope === "project" ? task.project_id ?? null : null
  const name = useStore((s) => (projectId ? s.projects[projectId]?.name ?? "Project" : "Global"))
  return (
    <span className="contents" onClick={stop} onPointerDown={stop} onKeyDown={stop}>
      <TaskProjectMenu
        task={task}
        trigger={
          <button type="button" className="tk-proj-chip" aria-label={`Project: ${name}. Change project`}>
            <ProjectDot projectId={projectId} />
            {showName && <span>{name}</span>}
          </button>
        }
      />
    </span>
  )
}
