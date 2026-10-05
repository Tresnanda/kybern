import { useEffect } from "react"

import { useGlobalNotesHome } from "@/lib/notesPrefs"
import { useEnvironments } from "@/state/environments"
import { attachEnvFeed, startHomeFeed, stopHomeFeed } from "@/state/notes"
import { activeRuntime } from "@/state/rpc"
import { useStore } from "@/state/store"

/**
 * Keep the notes lists current for this window: follow the environment's own
 * daemon, and, while Global notes are shared and this window shows another
 * environment, the local Mac's. Mount once, in the workspace.
 */
export function useNotesSync() {
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
    // Reconnecting re-runs this effect, which reads the lists again.
    return attachEnvFeed(client, environmentId)
  }, [open, environmentId])

  const preference = useGlobalNotesHome()
  const profileId = useEnvironments((s) => s.selectedId)
  const shared = preference === "shared" && profileId !== "local"
  useEffect(() => {
    if (!shared) return
    startHomeFeed()
    return stopHomeFeed
  }, [shared])
}
