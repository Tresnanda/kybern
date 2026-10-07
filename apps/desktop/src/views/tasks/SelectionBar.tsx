// The floating bar over the list or board while tasks are selected: how many, Send to
// agent, Status, Priority, Delete, and clear. It rises in and fades out along the
// page's bottom edge, and makes way for the batch composer that grows from the same edge.
import { useEffect, useMemo, useState } from "react"

import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/kit/tooltip"
import { mod } from "@/lib/format"
import { TrashCanIcon, XIcon } from "@/lib/kit/icons"
import { clearSelection, deleteSelectedTasks, openBatchComposer, setBulkMenu, useTasks } from "@/state/tasks"
import { isLiveRun, latestRun } from "@/state/tasksModel"
import { PriorityGlyph, TaskStatusGlyph } from "./TaskGlyphs"
import { TaskPriorityMenu, TaskStatusMenu } from "./TaskMenus"

export function SelectionBar() {
  const count = useTasks((s) => s.selected.size)
  const composing = useTasks((s) => !!s.batch)
  const show = count > 0 && !composing
  const [mounted, setMounted] = useState(show)
  // The count the bar last showed, so it does not read "0 selected" on its way out.
  const [last, setLast] = useState(count)
  if (count > 0 && count !== last) setLast(count)
  if (show && !mounted) setMounted(true)
  if (!mounted) return null
  return <Bar count={count > 0 ? count : last} leaving={!show} onGone={() => setMounted(false)} />
}

function Bar({ count, leaving, onGone }: { count: number; leaving: boolean; onGone: () => void }) {
  const selected = useTasks((s) => s.selected)
  const tasks = useTasks((s) => s.tasks)
  const menu = useTasks((s) => s.bulkMenu)
  const picked = useMemo(() => [...selected].flatMap((id) => (tasks[id] ? [tasks[id]!] : [])), [selected, tasks])
  const allRunning = picked.length > 0 && picked.every((task) => isLiveRun(latestRun(task)))
  // Kept mounted until the exit has played.
  useEffect(() => {
    if (!leaving) return
    const timer = window.setTimeout(onGone, 200)
    return () => window.clearTimeout(timer)
  }, [leaving, onGone])

  return (
    <div className="tk-selbar" role="toolbar" aria-label={`${count} selected ${count === 1 ? "task" : "tasks"}`} data-leaving={leaving || undefined}>
      <div className="tk-selbar-inner">
        <span className="count tk-num" aria-live="polite">
          {count} selected
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className="primary"
                data-selbar-send
                aria-disabled={allRunning || undefined}
                onClick={() => {
                  if (!allRunning) openBatchComposer()
                }}
              />
            }
          >
            Send to agent
          </TooltipTrigger>
          <TooltipPopup side="top">{allRunning ? "These tasks already have live runs" : `Start runs for the selected tasks (${mod}↵)`}</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TaskStatusMenu
            tasks={picked}
            side="top"
            open={menu === "status"}
            onOpenChange={(open) => setBulkMenu(open ? "status" : null)}
            trigger={
              <TooltipTrigger render={<button type="button" className="tk-btn" />}>
                <span className="gl">
                  <TaskStatusGlyph status="todo" mono />
                </span>
                Status
              </TooltipTrigger>
            }
          />
          <TooltipPopup side="top">Change status (S)</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TaskPriorityMenu
            tasks={picked}
            side="top"
            open={menu === "priority"}
            onOpenChange={(open) => setBulkMenu(open ? "priority" : null)}
            trigger={
              <TooltipTrigger render={<button type="button" className="tk-btn" />}>
                <span className="gl">
                  <PriorityGlyph priority={3} />
                </span>
                Priority
              </TooltipTrigger>
            }
          />
          <TooltipPopup side="top">Change priority (P)</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<button type="button" className="tk-btn" onClick={() => void deleteSelectedTasks()} />}>
            <span className="gl">
              <TrashCanIcon className="size-[15px]" />
            </span>
            Delete
          </TooltipTrigger>
          <TooltipPopup side="top">Delete ({mod}⌫). You can undo.</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<button type="button" className="tk-btn x" aria-label="Clear selection" onClick={clearSelection} />}>
            <XIcon className="size-[15px]" />
          </TooltipTrigger>
          <TooltipPopup side="top">Clear selection (Esc)</TooltipPopup>
        </Tooltip>
      </div>
    </div>
  )
}
