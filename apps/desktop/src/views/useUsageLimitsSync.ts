import { useEffect } from "react"

import { activeRuntime } from "@/state/rpc"
import { useStore } from "@/state/store"
import { attachUsageFeed } from "@/state/usageLimits"

/**
 * Keep this window's account limits current: ask when the connection opens (and
 * after every reconnect) and follow `usage.limits.changed`. Mount once, in the workspace.
 */
export function useUsageLimitsSync() {
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
    return attachUsageFeed(client, environmentId)
  }, [open, environmentId])
}
