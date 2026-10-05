// Status, priority and project pickers for a task. Each opens from its own trigger,
// or, for the S and P shortcuts, anchored to the focused row with no trigger at all.
import type { ReactElement, ReactNode } from "react"

import { ComposerPickerMenuPopup } from "@/components/kit/chat/ComposerPickerMenuPopup"
import { Menu, MenuGroup, MenuGroupLabel, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "@/components/kit/menu"
import type { ProjectId, TaskItem, TaskPriority, TaskStatus } from "@/protocol"
import { setTaskPriority, setTaskProject, setTaskStatus } from "@/state/tasks"
import { PRIORITY_LABEL, PRIORITY_MENU_ORDER, STATUS_LABEL, USER_STATUSES } from "@/state/tasksModel"
import { useStore } from "@/state/store"
import { ProjectDot } from "@/lib/kit/projectDot"
import { PriorityGlyph, TaskStatusGlyph } from "./TaskGlyphs"

interface PickerProps {
  /** The element that opens the menu. Omit it to open from `anchor` while `open`. */
  trigger?: ReactElement
  open?: boolean
  onOpenChange?: (open: boolean) => void
  anchor?: Element | null
  align?: "start" | "center" | "end"
}

function Picker({
  trigger,
  open,
  onOpenChange,
  anchor,
  align = "start",
  label,
  value,
  onValue,
  children,
}: PickerProps & { label: string; value: string; onValue: (value: string) => void; children: ReactNode }) {
  return (
    <Menu open={open} onOpenChange={onOpenChange ? (next) => onOpenChange(next) : undefined}>
      {trigger && <MenuTrigger render={trigger} />}
      <ComposerPickerMenuPopup align={align} side="bottom" anchor={trigger ? undefined : anchor} className="min-w-48">
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

export function TaskStatusMenu({ task, ...props }: PickerProps & { task: TaskItem }) {
  return (
    <Picker {...props} label="Status" value={task.status} onValue={(value) => value !== task.status && void setTaskStatus(task.id, value as TaskStatus)}>
      {USER_STATUSES.map((status) => (
        <MenuRadioItem closeOnClick key={status} value={status}>
          <TaskStatusGlyph status={status} />
          {STATUS_LABEL[status]}
        </MenuRadioItem>
      ))}
    </Picker>
  )
}

export function TaskPriorityMenu({ task, ...props }: PickerProps & { task: TaskItem }) {
  return (
    <Picker
      {...props}
      label="Priority"
      value={String(task.priority)}
      onValue={(value) => Number(value) !== task.priority && void setTaskPriority(task.id, Number(value) as TaskPriority)}
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
  const projects = useStore((s) => s.projects)
  const list = Object.values(projects).sort((a, b) => a.name.localeCompare(b.name))
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
