import path from 'node:path'
import { useSyncExternalStore } from 'react'
import { getState } from '../state.ts'
import { activeEnvironment } from '../shell/environment.ts'
import { chooseTab, setDock } from './store.ts'
export interface ExplorerContext { environmentId: string; revision: number; threadId: string; projectId: string; cwd: string; projectRoot: string }
export interface ExplorerSelection extends ExplorerContext { path: string; ancestors: string[] }
/** files.list/read are rooted at the project, so never map a different worktree
 * onto a same-named project file. The request also expires on workspace changes. */
export function explorerSelection(context: ExplorerContext, absolute: string): ExplorerSelection | null {
  const relative = path.relative(context.projectRoot, absolute)
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) return null
  const parts = relative.split(path.sep), ancestors = parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'))
  return { ...context, path: parts.join('/'), ancestors }
}
export function sameExplorerContext(a: ExplorerContext, b: ExplorerContext) { return a.environmentId === b.environmentId && a.revision === b.revision && a.threadId === b.threadId && a.projectId === b.projectId && a.cwd === b.cwd && a.projectRoot === b.projectRoot }
let pending: ExplorerSelection | null = null
const listeners = new Set<() => void>(), emit = () => listeners.forEach(l => l())
function contextFor(threadId: string, projectId: string): ExplorerContext | null {
  const state = getState(), thread = state.threads.find(t => t.id === threadId && t.project_id === projectId), project = state.projects.find(p => p.id === projectId), environment = activeEnvironment()
  return thread && project ? { environmentId: environment.id, revision: environment.revision, threadId, projectId, cwd: thread.cwd, projectRoot: project.path } : null
}
export function canShowFileInExplorer(threadId: string, projectId: string, absolute: string) { const context = contextFor(threadId, projectId); return !!context && !!explorerSelection(context, absolute) }
export function showFileInExplorer(threadId: string, projectId: string, absolute: string) {
  const context = contextFor(threadId, projectId)
  if (!context) return
  pending = explorerSelection(context, absolute)
  if (!pending) return
  chooseTab(threadId, 'explorer'); setDock(threadId, { open: true }); emit()
}
export function takeExplorerSelection(threadId: string, projectId: string) {
  const request = pending
  // Another visible/frozen pane must not consume the intended Explorer's request.
  if (!request || request.threadId !== threadId || request.projectId !== projectId) return null
  const context = contextFor(threadId, projectId)
  pending = null; emit()
  return request && context && sameExplorerContext(request, context) ? request : null
}
export function useExplorerSelection() { return useSyncExternalStore(l => { listeners.add(l); return () => { listeners.delete(l) } }, () => pending) }
