// How a task reference reads inside a note: the task's status glyph and key, live
// from the tasks store. On a checklist line the status word follows in quiet text
// (styles/notes.css shows it only there). A click opens the task; hovering names
// it. A task that no longer exists keeps its key, muted and struck through.
import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react"

import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/kit/tooltip"
import { openTask, useTask, useTasks } from "@/state/tasks"
import { STATUS_LABEL } from "@/state/tasksModel"
import { TaskStatusGlyph } from "../tasks/TaskGlyphs"

export function TaskRefView({ node, selected }: ReactNodeViewProps) {
  const id = node.attrs.id as string
  const label = node.attrs.label as string
  const task = useTask(id)
  // Until the list arrives a reference is only pending, not missing.
  const known = useTasks((s) => s.loaded && s.supported)
  const missing = !task && known
  const key = task?.key ?? label

  return (
    <NodeViewWrapper as="span" className="task-ref" data-state={task ? task.status : missing ? "missing" : "pending"} data-selected={selected || undefined}>
      <Tooltip>
        <TooltipTrigger
          delay={350}
          render={
            <span
              role="link"
              aria-label={task ? `${task.key}: ${task.title}, ${STATUS_LABEL[task.status]}` : missing ? `${label}, task removed` : label}
              className="task-ref-hit"
              onClick={(event) => {
                if (!task) return
                event.preventDefault()
                event.stopPropagation()
                openTask(task.id)
              }}
            />
          }
        >
          {task ? <TaskStatusGlyph status={task.status} size={12} className="task-ref-glyph" /> : <span className="task-ref-glyph task-ref-glyph-empty" aria-hidden="true" />}
          <span className="task-ref-key">{key}</span>
          {task && <span className="task-ref-status">{STATUS_LABEL[task.status]}</span>}
        </TooltipTrigger>
        <TooltipPopup side="top" className="max-w-72">
          {task ? task.title.trim() || "Untitled task" : missing ? "Task removed" : "Loading task"}
        </TooltipPopup>
      </Tooltip>
    </NodeViewWrapper>
  )
}
