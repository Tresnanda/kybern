// "Add project…" for surfaces that stay put afterwards (Tasks, Notes): a folder from
// the native picker on This Mac, or the environment's own folder browser elsewhere.
// The new project goes to `onAdded` instead of opening its home screen.
import { useState, type ReactNode } from "react"
import { toast } from "sonner"

import { pickFolder } from "@/lib/tauri"
import type { Project } from "@/protocol"
import { activeEnvironment } from "@/state/environments"
import { addProject, errorText } from "@/state/rpc"
import { useStore } from "@/state/store"
import { ProjectPicker } from "./ProjectPicker"

/** `add` starts it; render `dialog` once, for environments that browse their own folders. */
export function useAddProject(onAdded: (project: Project) => void): { add: () => void; dialog: ReactNode } {
  const [browsing, setBrowsing] = useState(false)
  const add = () => {
    const store = useStore
    if (store.getState().connection.state !== "open") {
      toast("Connect to this environment before adding a project")
      return
    }
    if (!activeEnvironment()?.local) {
      setBrowsing(true)
      return
    }
    void (async () => {
      const path = await pickFolder()
      // The window may have switched environments while the picker was open.
      if (!path || store !== useStore) return
      try {
        onAdded(await addProject(path))
      } catch (error) {
        toast.error("Unable to add project", { description: errorText(error) })
      }
    })()
  }
  return { add, dialog: <ProjectPicker open={browsing} onOpenChange={setBrowsing} onAdded={onAdded} /> }
}
