// Group projects (several git repositories under one folder) on the GPUIX side: whether the daemon can make them,
// a per-project cache of `projects.members.status` (branches, dirty files, instruction files, copy candidates) shared by
// the tray, the badge card, the Repositories dialog and the instructions offer, and the worktree preparation progress
// (`threads.workspace_progress`) the first turn of a new chat reports. Labels, ordering and validation live in
// `packages/kybern-client/src/groups.ts`.
import { useSyncExternalStore } from 'react'
import {
  THREADS_WORKSPACE_PROGRESS_NOTIFICATION,
  type Project,
  type ProjectId,
  type ProjectsMembersStatusResult,
  type ThreadId,
  type ThreadsWorkspaceProgress,
} from '../../../../packages/kybern-client/src/types.ts'
import { onEnvironmentChange } from '../shell/environment.ts'
import { getClient, getState, refreshLists, set } from '../state.ts'
import { useNav } from '../nav/store.ts'

/** Group projects need daemon 0.15.0 (L3 spec §0). `KYBERN_GROUPS=1` forces them on for fixtures and pre-release daemons. */
export function groupsSupported(version: string | null | undefined): boolean {
  if (process.env.KYBERN_GROUPS === '1') return true
  if (process.env.KYBERN_GROUPS === '0') return false
  const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? '')
  if (!parts) return false
  const [major, minor] = [Number(parts[1]), Number(parts[2])]
  return major > 0 || minor >= 15
}

export const useGroupsSupported = () => useNav((s) => groupsSupported(s.version))

// ---- member status ----

type Status = { projectId: ProjectId; result: ProjectsMembersStatusResult | null; error: string | null; at: number }
let statuses: Record<ProjectId, Status> = {}
const statusListeners = new Set<() => void>()
const inflight = new Map<ProjectId, Promise<ProjectsMembersStatusResult | null>>()
/** A status this fresh is reused instead of re-probing every member's git state. */
const FRESH_MS = 15_000

function setStatus(projectId: ProjectId, patch: Partial<Status>) {
  const prev = statuses[projectId] ?? { projectId, result: null, error: null, at: 0 }
  statuses = { ...statuses, [projectId]: { ...prev, ...patch } }
  for (const listener of statusListeners) listener()
}

export const getMemberStatus = (projectId: ProjectId) => statuses[projectId]

/** Read `projects.members.status`, sharing one call per project; `force` skips the cache. */
export function loadMemberStatus(projectId: ProjectId, force = false): Promise<ProjectsMembersStatusResult | null> {
  const cached = statuses[projectId]
  if (!force && cached?.result && Date.now() - cached.at < FRESH_MS) return Promise.resolve(cached.result)
  const running = inflight.get(projectId)
  if (running) return running
  const client = getClient()
  if (!client) return Promise.resolve(null)
  const call = client.call('projects.members.status', { project_id: projectId }).then(
    (result) => {
      if (getClient() === client) setStatus(projectId, { result, error: null, at: Date.now() })
      return result
    },
    (error: unknown) => {
      if (getClient() === client) setStatus(projectId, { error: error instanceof Error ? error.message : String(error) })
      return null
    },
  ).finally(() => inflight.delete(projectId))
  inflight.set(projectId, call)
  return call
}

/** Replace the cached status (fixtures, and the dialog after an update it made). */
export function setMemberStatus(projectId: ProjectId, result: ProjectsMembersStatusResult) {
  setStatus(projectId, { result, error: null, at: Date.now() })
}

export function useMemberStatus(projectId: ProjectId | null | undefined): ProjectsMembersStatusResult | null {
  return useSyncExternalStore(
    (listener) => { statusListeners.add(listener); return () => { statusListeners.delete(listener) } },
    () => (projectId ? statuses[projectId]?.result ?? null : null),
  )
}

// ---- project updates ----

/** `projects.update` for a group, applied to the list at once so the sidebar and tray follow without waiting for the notification. */
export async function updateGroup(projectId: ProjectId, patch: { members?: string[]; worktree_copy?: string[]; instructions_offer_dismissed?: boolean }): Promise<Project> {
  const client = getClient()
  if (!client) throw new Error('Reconnect and try again.')
  const project = await client.call('projects.update', { project_id: projectId, ...patch })
  if (getClient() === client) {
    set({ projects: getState().projects.map((p) => (p.id === project.id ? project : p)) })
    if (patch.members) void loadMemberStatus(projectId, true)
    void refreshLists()
  }
  return project
}

// ---- worktree preparation ----

let progress: Record<ThreadId, ThreadsWorkspaceProgress> = {}
const progressListeners = new Set<() => void>()

export function applyWorkspaceProgress(next: ThreadsWorkspaceProgress) {
  progress = { ...progress, [next.thread_id]: next }
  for (const listener of progressListeners) listener()
}

/** Follow `threads.workspace_progress` on a fresh connection (`nav/live.ts`). */
export function followWorkspaceProgress(): () => void {
  const client = getClient()
  if (!client) return () => {}
  return client.onNotification(THREADS_WORKSPACE_PROGRESS_NOTIFICATION, (params) => {
    if (getClient() !== client) return
    const value = params as ThreadsWorkspaceProgress | null
    if (value && typeof value.thread_id === 'string' && typeof value.total === 'number') applyWorkspaceProgress(value)
  })
}

export function useWorkspaceProgress(threadId: ThreadId | null | undefined): ThreadsWorkspaceProgress | undefined {
  return useSyncExternalStore(
    (listener) => { progressListeners.add(listener); return () => { progressListeners.delete(listener) } },
    () => (threadId ? progress[threadId] : undefined),
  )
}

onEnvironmentChange(() => {
  statuses = {}
  progress = {}
  inflight.clear()
  for (const listener of statusListeners) listener()
  for (const listener of progressListeners) listener()
})
