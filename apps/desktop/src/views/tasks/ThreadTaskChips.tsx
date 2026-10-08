import { Popover, PopoverPopup, PopoverTrigger } from "@/components/kit/popover"
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/kit/tooltip"
import type { ThreadId } from "@/protocol"
import { openTask, useThreadTasks } from "@/state/tasks"
import { STATUS_LABEL } from "@/state/tasksModel"

import { ChatHeaderButton } from "../chrome"
import { TaskStatusGlyph } from "./TaskGlyphs"

/**
 * The thread header's task context: one chip for the task this thread runs, or a
 * compact "ADE-30 +3" group with a list when it runs several (a combined batch,
 * or an agent that claimed more than one).
 */
export function ThreadTaskChips({ threadId }: { threadId: ThreadId }) {
  const tasks = useThreadTasks(threadId)
  if (tasks.length === 0) return null
  const [first] = tasks
  if (tasks.length === 1) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={<ChatHeaderButton type="button" tone="plain" className="max-w-40 gap-1.5 px-1.5 text-muted-foreground" onClick={() => openTask(first.id)} />}
        >
          <TaskStatusGlyph status={first.status} size={13} animated />
          <span className="truncate tabular-nums">{first.key}</span>
        </TooltipTrigger>
        <TooltipPopup side="bottom">{first.title || "Untitled task"}</TooltipPopup>
      </Tooltip>
    )
  }
  const running = tasks.filter((task) => task.status === "running").length
  return (
    <Popover>
      <PopoverTrigger
        render={
          <ChatHeaderButton
            type="button"
            tone="plain"
            className="gap-1.5 px-1.5 text-muted-foreground"
            aria-label={`${tasks.length} tasks in this thread`}
          />
        }
      >
        <TaskStatusGlyph status={running > 0 ? "running" : first.status} size={13} animated />
        <span className="truncate tabular-nums">
          {first.key} +{tasks.length - 1}
        </span>
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="start" sideOffset={6} scrollable className="w-72 font-system-ui [&_[data-slot=popover-viewport]]:!py-1.5 [&_[data-slot=popover-viewport]]:![--viewport-inline-padding:--spacing(1.5)]">
        <div className="flex w-full flex-col">
          <div className="px-2 pb-1 pt-0.5 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
            {tasks.length} tasks in this thread{running > 0 ? ` · ${running} running` : ""}
          </div>
          {tasks.map((task) => (
            <button
              key={task.id}
              type="button"
              onClick={() => openTask(task.id)}
              className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[length:var(--app-font-size-ui,12px)] transition-colors hover:bg-[var(--color-background-button-secondary-hover)]"
            >
              <TaskStatusGlyph status={task.status} size={14} animated title={STATUS_LABEL[task.status]} />
              <span className="shrink-0 tabular-nums text-muted-foreground">{task.key}</span>
              <span className="min-w-0 flex-1 truncate">{task.title || "Untitled task"}</span>
            </button>
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  )
}
