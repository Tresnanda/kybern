import { useEffect } from "react"

import { activeRuntime } from "@/state/rpc"
import { attachAccountsFeed } from "@/state/accounts"
import { useStore } from "@/state/store"

/** Load this environment's accounts when the connection opens and follow finished sign-ins. Mount once, in the workspace. */
export function useAccountsSync() {
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
    return attachAccountsFeed(client)
  }, [open, environmentId])
}
