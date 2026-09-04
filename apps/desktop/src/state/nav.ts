import { toast } from "sonner"

import { resolveFocusedThreadId } from "./splitView"
import { useStore } from "./store"

export function newThread(projectId?: string) {
  const s = useStore.getState()
  const splitThreadId = resolveFocusedThreadId(s.splitView, true)
  const pid =
    projectId ??
    (s.selected.kind === "thread"
      ? s.threads[s.selected.id]?.project_id
      : s.selected.kind === "draft"
        ? s.selected.draft.projectId
        : splitThreadId
          ? s.threads[splitThreadId]?.project_id
          : undefined) ??
    Object.keys(s.projects)[0]
  if (!pid) {
    toast("Add a project first")
    return
  }
  s.selectDraft(pid)
}

