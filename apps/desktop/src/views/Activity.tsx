import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import { Spinner } from "@/components/kybern/bits"
import { ThreadRunningSpinner } from "@/components/kit/ThreadRunningSpinner"
import { Button } from "@/components/kit/button"
import { plural } from "@/lib/format"
import {
  BackgroundTrayIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  ClockIcon,
  StopIcon,
  TerminalIcon,
  WorkflowIcon,
} from "@/lib/kit/icons"
import { cn } from "@/lib/utils"
import type { RuntimeTask, RuntimeTaskStatus, ThreadId } from "@/protocol"
import { backgroundRuntimeTask, errorText, stopRuntimeTask } from "@/state/rpc"
import { isRuntimeTaskActive, useStore } from "@/state/store"

const SECTION_LABEL = "px-3 pb-1 pt-3 text-[length:var(--app-font-size-ui-sm,11px)] font-normal text-muted-foreground/55"
const EMPTY_RUNTIME_TASKS: RuntimeTask[] = []

export function ActivityPane({ threadId }: { threadId: ThreadId }) {
  const tasks = useStore((state) => state.runtimeTasks[threadId] ?? EMPTY_RUNTIME_TASKS)
  const active = useMemo(() => tasks.filter(isRuntimeTaskActive), [tasks])
  const recent = useMemo(() => tasks.filter((task) => !isRuntimeTaskActive(task)).slice(0, 20), [tasks])
  const now = useNow(active.length > 0)

  if (tasks.length === 0) {
    return (
      <div className="t-stagger flex h-full w-full flex-col items-center justify-center px-8 text-center font-system-ui">
        <span className="mb-3 flex size-8 items-center justify-center rounded-lg bg-[var(--color-background-elevated-secondary)] text-muted-foreground/70">
          <WorkflowIcon className="size-4" />
        </span>
        <p className="text-[length:var(--app-font-size-ui,12px)] font-medium text-foreground/80">No background work</p>
        <p className="mt-1 max-w-64 text-[length:var(--app-font-size-ui-sm,11px)] leading-4 text-muted-foreground/60">
          Agents and processes started by this thread appear here.
        </p>
      </div>
    )
  }

  return (
    <div className="h-full min-h-0 w-full overflow-y-auto font-system-ui">
      {active.length > 0 && (
        <section aria-labelledby="active-work-heading">
          <h2 id="active-work-heading" className={SECTION_LABEL}>
            Active · {plural(active.length, "task")}
          </h2>
          <div className="t-stagger px-1.5 pb-1.5">
            {active.map((task) => (
              <RuntimeTaskRow key={task.id} task={task} now={now} />
            ))}
          </div>
        </section>
      )}
      {recent.length > 0 && (
        <section aria-labelledby="recent-work-heading" className={cn(active.length > 0 && "border-t border-[color:var(--color-border-light)]")}>
          <h2 id="recent-work-heading" className={SECTION_LABEL}>
            Recent
          </h2>
          <div className="t-stagger px-1.5 pb-2">
            {recent.map((task) => (
              <RuntimeTaskRow key={task.id} task={task} now={now} />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

function RuntimeTaskRow({ task, now }: { task: RuntimeTask; now: number }) {
  const [action, setAction] = useState<"stop" | "background" | null>(null)
  const active = isRuntimeTaskActive(task)
  const metrics = taskMetrics(task, now)
  const detail = task.detail || (task.last_tool_name ? `Using ${task.last_tool_name}` : statusLabel(task.status, task.backgrounded))

  const run = async (kind: "stop" | "background") => {
    setAction(kind)
    try {
      if (kind === "stop") await stopRuntimeTask(task.thread_id, task.id)
      else await backgroundRuntimeTask(task.thread_id, task.id)
    } catch (error) {
      toast.error(kind === "stop" ? "Unable to stop task" : "Unable to move task", { description: errorText(error) })
    } finally {
      setAction(null)
    }
  }

  return (
    <article
      className={cn(
        "group/activity-row flex min-w-0 gap-2 rounded-lg px-2 py-2 outline-none transition-colors hover:bg-[var(--color-background-elevated-secondary)]",
        task.parent_id && "ml-3",
      )}
    >
      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center text-[var(--color-text-foreground-secondary)]">
        <TaskGlyph task={task} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-start gap-2">
          <p
            title={task.title}
            className={cn(
              "min-w-0 flex-1 truncate text-[length:var(--app-font-size-ui,12px)] font-medium text-foreground/90",
              task.kind === "process" && "font-mono text-[length:var(--app-font-size-ui-sm,11px)] font-normal",
            )}
          >
            {task.title}
          </p>
          {metrics && <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/52">{metrics}</span>}
        </div>
        <p title={detail} className="mt-0.5 truncate text-[length:var(--app-font-size-ui-sm,11px)] leading-4 text-muted-foreground/62">
          {detail}
        </p>
        {active && (task.capabilities.background || task.capabilities.stop) && (
          <div className="mt-1.5 flex items-center gap-1">
            {task.capabilities.background && (
              <Button size="chip" variant="ghost" disabled={action !== null} onClick={() => void run("background")}>
                {action === "background" ? <Spinner size={12} /> : <BackgroundTrayIcon className="size-3" />}
                Move to background
              </Button>
            )}
            {task.capabilities.stop && (
              <Button size="chip" variant="ghost" disabled={action !== null || task.status === "stopping"} onClick={() => void run("stop")}>
                {action === "stop" || task.status === "stopping" ? <Spinner size={12} /> : <StopIcon className="size-3" />}
                Stop
              </Button>
            )}
          </div>
        )}
      </div>
    </article>
  )
}

function TaskGlyph({ task }: { task: RuntimeTask }) {
  if (task.status === "failed") return <CircleAlertIcon className="size-3.5 text-destructive" />
  if (!isRuntimeTaskActive(task)) return <CircleCheckIcon className="size-3.5 opacity-60" />
  if (task.status === "running" || task.status === "pending" || task.status === "stopping") return <ThreadRunningSpinner className="size-3.5" />
  if (task.kind === "process") return <TerminalIcon className="size-3.5" />
  if (task.kind === "monitor") return <ClockIcon className="size-3.5" />
  return <WorkflowIcon className="size-3.5" />
}

function statusLabel(status: RuntimeTaskStatus, backgrounded: boolean): string {
  if (status === "pending") return "Starting"
  if (status === "running") return backgrounded ? "Running in background" : "Running"
  if (status === "waiting") return backgrounded ? "Monitoring in background" : "Waiting"
  if (status === "stopping") return "Stopping"
  if (status === "completed") return "Completed"
  if (status === "failed") return "Failed"
  if (status === "stopped") return "Stopped"
  return "Interrupted"
}

function taskMetrics(task: RuntimeTask, now: number): string {
  const parts: string[] = []
  const elapsed = Math.max(0, (task.completed_at ? Date.parse(task.completed_at) : now) - Date.parse(task.started_at))
  parts.push(formatDuration(task.stats.duration_ms ?? elapsed))
  if (task.stats.token_count) parts.push(formatCompact(task.stats.token_count, "tokens"))
  else if (task.usage) parts.push(formatCompact(task.usage.input_tokens + task.usage.output_tokens, "tokens"))
  if (task.stats.cpu_percent != null) parts.push(`${task.stats.cpu_percent.toFixed(task.stats.cpu_percent >= 10 ? 0 : 1)}% CPU`)
  if (task.stats.rss_kb != null) parts.push(formatMemory(task.stats.rss_kb))
  return parts.join(" · ")
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function formatCompact(value: number, unit: string): string {
  return `${new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value)} ${unit}`
}

function formatMemory(kb: number): string {
  if (kb < 1024) return `${kb} KB`
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(kb / 1024)} MB`
}

function useNow(enabled: boolean): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!enabled) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [enabled])
  return now
}
