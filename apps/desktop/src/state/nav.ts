import { useStore } from "./store"

export function newThread(projectId?: string) {
  const s = useStore.getState()
  if (!projectId) {
    s.selectFreeDraft()
    return
  }
  s.selectDraft(projectId)
}
