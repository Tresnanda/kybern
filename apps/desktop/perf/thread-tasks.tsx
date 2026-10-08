// Visual fixture: one thread that runs several tasks. The thread header shows the
// task chip group (open it with ?open=1) and each task's board card shows the run's
// activity. ?theme=light|dark, ?tasks=1|2|4 sets how many tasks the thread runs.
import { createRoot } from "react-dom/client"
import type { TaskItem, TaskRun } from "../src/protocol"
import { useTasks } from "../src/state/tasks"
import { SurfaceHeader } from "../src/views/chrome"
import { TaskBoard } from "../src/views/tasks/TaskBoard"
import { ThreadTaskChips } from "../src/views/tasks/ThreadTaskChips"
import { applyAppearance } from "../src/lib/kit/applyTheme"
import "../src/index.css"

const params = new URLSearchParams(location.search)
const count = Number(params.get("tasks") ?? 4)
const THREAD = "00000000-0000-0000-0000-0000000000a1"
const now = Date.parse("2026-10-08T12:00:00Z")
const run = (thread: string, activity: string): TaskRun => ({
  thread_id: thread, number: 1, provider: { kind: "claude", instance: "claude" } as TaskRun["provider"],
  started_at: new Date(now - 54 * 60_000).toISOString(), state: "running", activity,
})
const titles = ["Move agent claims onto several tasks", "Show task chips in the thread header", "Reopen only the claimed task", "Cover turn end with a test", "Unrelated: tune the sidebar"]
const activities = ["Running cd desktop && pnpm typecheck", "Editing views/tasks/ThreadTaskChips.tsx", "Reading crates/kybern-daemon/src/orchestrator.rs", "Running cargo test -p kybern-daemon"]
const tasks: Record<string, TaskItem> = {}
titles.forEach((title, i) => {
  const mine = i < count
  const id = `00000000-0000-0000-0000-00000000010${i}`
  tasks[id] = {
    id, key: `ADE-${30 + i}`, scope: "global", title, body: "", status: mine ? "running" : "todo", priority: 3, rank: i, note_ids: [],
    runs: mine ? [run(THREAD, activities[i % activities.length]!)] : [], revision: 1,
    created_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString(), status_changed_at: new Date(now).toISOString(),
  } as TaskItem
})
useTasks.setState({ tasks, loaded: true })
applyAppearance(params.get("theme") === "light" ? "light" : "dark")
const all = Object.values(tasks)
const columns = [
  { status: "todo" as const, tasks: all.filter((t) => t.status === "todo") },
  { status: "running" as const, tasks: all.filter((t) => t.status === "running") },
]
createRoot(document.getElementById("root")!).render(
  <div className="tk-page font-system-ui flex h-screen flex-col bg-background text-foreground" style={{ width: Number(params.get("w") ?? 1000) }}>
    <SurfaceHeader inline dock={false}>
      <span className="truncate text-[12px]">Ship multi-task claims</span>
      <ThreadTaskChips threadId={THREAD} />
    </SurfaceHeader>
    <div className="min-h-0 flex-1 overflow-auto"><TaskBoard columns={columns} tasks={tasks} now={now} /></div>
  </div>,
)
if (params.get("open")) setTimeout(() => document.querySelector<HTMLElement>("[data-slot=popover-trigger]")?.click(), 400)
