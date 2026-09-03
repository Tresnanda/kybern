import { toast } from "sonner"

import { useStore } from "./store"

export function newThread(projectId?: string) {
  const s = useStore.getState()
  const pid = projectId ?? (s.selected.kind === "thread" ? s.threads[s.selected.id]?.project_id : s.selected.kind === "draft" ? s.selected.draft.projectId : undefined) ?? Object.keys(s.projects)[0]
  if (!pid) {
    toast("Add a project first")
    return
  }
  s.selectDraft(pid)
}

