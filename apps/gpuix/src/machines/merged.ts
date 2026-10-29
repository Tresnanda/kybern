// The merged lists as `state.ts` shows them (design §5.2 step 2).
//
// The app's lists stay `Project[]` / `Thread[]`: the machine the user is at keeps
// its own objects untouched, so one machine looks and costs what it always did.
// Other machines add to them:
//
// - A project that exists on several machines is one row: the local checkout when
//   the user has one, else the first machine's. Projects only another machine has
//   are listed as they are, with the space of the default space.
// - A thread of another machine is listed under that row: its `project_id` becomes
//   the row's project, `ownProjectId` keeps its own, and `machineId` names its owner.
//   Everything that looks a project up by `thread.project_id` keeps working.
//
// Remapped objects are memoized per source object, so a refresh that changed one
// machine leaves every other row the same object.
import { isChildThread, isInboundThread, isRemoteChildThread } from '../../../../packages/kybern-client/src/subagents.ts'
import type { MachineThread, MergedThread } from '../../../../packages/kybern-client/src/machineMerge.ts'
import type { MergedView } from '../../../../packages/kybern-client/src/machines.ts'
import { FREE_CHAT_PROJECT_ID, isFreeChatProject, type MachineId, type Project, type Thread } from '../../../../packages/kybern-client/src/types.ts'

/** A thread as the app lists it. The machine the user is at has none of the extra fields. */
export type StateThread = Thread & {
  /** The owning machine; unset for the machine the user is at. */
  machineId?: MachineId
  /** The thread's own project on its machine, when `project_id` was moved to the merged row. */
  ownProjectId?: string
  /** The owning machine is not reachable: this is its last cached copy. */
  offline?: boolean
  lastSeenAt?: number
}

export interface MergedLists {
  projects: Project[]
  /** Threads of other machines, ready to be listed with the local ones. */
  threads: StateThread[]
  /**
   * Delegated children other machines run for a thread, ready for `nav.children`: `parent_thread_id` names the thread that
   * delegated them (their `origin`), so the transcript's launch card and the sidebar find them like a local child.
   */
  children: StateThread[]
  /** Machines that have a checkout of a listed project, by the listed project's id. */
  machinesOf: Map<string, MachineId[]>
}

export interface MergeInput {
  view: MergedView
  localProjects: readonly Project[]
  /** The space remote-only projects are listed in (the default space), or null. */
  spaceOfForeign: () => string | null
}

export class ListMerger {
  private readonly foreignProjects = new WeakMap<Project, { space: string | null; project: Project }>()
  private readonly remapped = new WeakMap<Thread, { projectId: string; offline: boolean; lastSeenAt?: number; result: StateThread }>()

  merge(input: MergeInput): MergedLists {
    const { view, localProjects } = input
    const local = view.machines.find((machine) => machine.isLocal)?.machineId
    const space = input.spaceOfForeign()
    const localIds = new Set(localProjects.map((project) => project.id))
    const machinesOf = new Map<string, MachineId[]>()
    const shown = new Map<string, string>()   // logical key -> listed project id
    const projects: Project[] = [...localProjects]
    const remoteOnly: Project[] = []
    for (const logical of view.projects) {
      const here = local ? logical.instances.find((instance) => instance.machineId === local && localIds.has(instance.project.id)) : undefined
      if (here) {
        shown.set(logical.key, here.project.id)
        machinesOf.set(here.project.id, logical.instances.map((instance) => instance.machineId))
        continue
      }
      // Free chat is every machine's; a remote one is listed with the local "Chats".
      if (logical.instances.every((instance) => isFreeChatProject(instance.project.id))) { shown.set(logical.key, FREE_CHAT_PROJECT_ID); continue }
      const primary = logical.primary.project
      let entry = this.foreignProjects.get(primary)
      if (!entry || entry.space !== space) {
        entry = { space, project: space === null ? primary : { ...primary, space_id: space } }
        this.foreignProjects.set(primary, entry)
      }
      remoteOnly.push(entry.project)
      shown.set(logical.key, primary.id)
      machinesOf.set(primary.id, logical.instances.map((instance) => instance.machineId))
    }
    projects.push(...remoteOnly)
    const threads: StateThread[] = []
    const children: StateThread[] = []
    for (const merged of view.threads.all) {
      if (merged.machineId === local) continue
      const thread = merged.thread as MachineThread
      // The hidden threads that record another machine's tool calls are never listed, even from a cached copy of an older list.
      if (isInboundThread(thread) || thread.status === 'archived') continue
      if (isRemoteChildThread(thread)) children.push(this.remap(merged, shown.get(merged.projectKey) ?? thread.project_id))
      else if (!isChildThread(thread)) threads.push(this.remap(merged, shown.get(merged.projectKey) ?? thread.project_id))
    }
    return { projects, threads, children, machinesOf }
  }

  private remap(merged: MergedThread, projectId: string): StateThread {
    const thread = merged.thread as Thread
    const offline = merged.offline
    const own = projectId === thread.project_id ? undefined : thread.project_id
    const old = this.remapped.get(thread)
    if (old && old.projectId === projectId && old.offline === offline && old.lastSeenAt === merged.lastSeenAt) return old.result
    const result: StateThread = {
      ...thread,
      project_id: projectId,
      ...(isRemoteChildThread(thread) ? { parent_thread_id: thread.origin!.thread_id! } : {}),
      machineId: merged.machineId,
      ...(own ? { ownProjectId: own } : {}),
      ...(offline ? { offline: true } : {}),
      ...(merged.lastSeenAt !== undefined ? { lastSeenAt: merged.lastSeenAt } : {}),
    }
    this.remapped.set(thread, { projectId, offline, ...(merged.lastSeenAt !== undefined ? { lastSeenAt: merged.lastSeenAt } : {}), result })
    return result
  }
}

/** Pinned first, then newest: the order the sidebar lists threads in. */
export const byPinnedThenNewest = (a: Thread, b: Thread) => Number(b.pinned) - Number(a.pinned) || b.updated_at.localeCompare(a.updated_at)

/** A thread's project on the machine that owns it. */
export const ownProjectOf = (thread: Pick<StateThread, 'project_id' | 'ownProjectId'>) => thread.ownProjectId ?? thread.project_id
