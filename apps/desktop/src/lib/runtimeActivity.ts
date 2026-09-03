import { plural } from "@/lib/format"
import type { RuntimeTask } from "@/protocol"
import { isRuntimeTaskActive } from "@/state/store"

export function activeTaskSummary(tasks: RuntimeTask[]): string {
  const active = tasks.filter(isRuntimeTaskActive)
  const agents = active.filter((task) => task.kind === "agent").length
  const background = active.filter((task) => task.kind !== "agent").length
  if (agents > 0) return `${plural(agents, "agent")} working${background > 0 ? ` · ${plural(background, "background task")}` : ""}`
  return plural(background, "background task")
}
