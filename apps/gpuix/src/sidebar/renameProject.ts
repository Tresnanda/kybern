// Which project row is showing its inline name field. The row's context menu and the palette both
// start it; the row reads it, so a rename begun from the palette lands on the right row.
import { useSyncExternalStore } from 'react'
import { onEnvironmentChange } from '../shell/environment.ts'
import { getState, toggleSidebar } from '../state.ts'

let renaming: string | null = null
const listeners = new Set<() => void>()
const set = (id: string | null) => {
  if (renaming === id) return
  renaming = id
  for (const listener of listeners) listener()
}

export const renamingProjectId = () => renaming
export const startProjectRename = (projectId: string) => set(projectId)
/** The palette's entry: reveal the thread panel if it is hidden, then edit the row's name. */
export function renameProjectInline(projectId: string) {
  if (!getState().sidebarOpen) toggleSidebar()
  set(projectId)
}
export const stopProjectRename = (projectId: string) => { if (renaming === projectId) set(null) }

export function useRenamingProject(projectId: string): boolean {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => renaming === projectId)
}

onEnvironmentChange(() => set(null), -50)
