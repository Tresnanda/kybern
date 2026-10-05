import { useEffect } from "react"

import { attachTasksFeed } from "@/state/tasks"
import { activeRuntime } from "@/state/rpc"
import { useStore } from "@/state/store"

/**
 * Keep this window's tasks current: list them when the connection opens (and again
 * after every reconnect) and follow `tasks.items.changed`. Mount once, in the workspace.
 */
export function useTasksSync() {
  const open = useStore((s) => s.connection.state === "open")
  const environmentId = useStore((s) => s.environmentId)
  useEffect(() => {
    if (!open) return
    let client
    try {
      client = activeRuntime().rpc()
    } catch {
      return
    }
    return attachTasksFeed(client, environmentId)
  }, [open, environmentId])
}
