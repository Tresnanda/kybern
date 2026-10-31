// Children of threads on other machines, in the sidebar's and the transcript's child set (`nav.children`).
//
// Two kinds reach it:
//
// - A child another machine started lists on its own machine as a thread with an `origin` and no parent there
//   (`isRemoteChildThread`). `machines/merged.ts` hands those over with `parent_thread_id` set to the thread that delegated
//   them, so the launch card (`useChildThreads`) and the sidebar's child rows treat them like local children, with the
//   child's real state: the target's events keep its list, and so this set, current.
// - The subagents and delegated children of a thread on another machine, on that same machine. `threads.list` leaves them
//   out like it does here, so `remoteLive.ts` reads them per parent into `RemoteChildStore` and follows that machine's
//   events, as `live.ts` does for the local daemon; `machines/merged.ts` gives them their machine and listed project.
// - A child another machine's thread started on the machine the user is at: a local thread like the first kind, which
//   `state.ts` keeps in `OriginChildren` from the lists and live events.
//
// Whatever machines parent and child are on, `underParents` nests a child under the thread that started it, in that
// thread's project row, and the child keeps its own machine, so it opens there.
import { isChildThread, isRemoteChildThread } from '../../../../packages/kybern-client/src/subagents.ts'
import { scopedKey } from '../../../../packages/kybern-client/src/machineMerge.ts'
import type { MachineId, Thread, ThreadId } from '../../../../packages/kybern-client/src/types.ts'
import type { StateThread } from '../machines/merged.ts'

export interface RemoteChildSet {
  /** The ids this module put in `nav.children`, so the next call can take them out again. */
  ids: ReadonlySet<ThreadId>
  /** The next `nav.children`, or null when nothing changed. */
  children: Record<ThreadId, Thread> | null
}

/** Bring `current` in line with `remote`. A child of this machine with the same id wins; unchanged objects keep their identity. */
export function withRemoteChildren(current: Record<ThreadId, Thread>, remote: readonly (Thread & { machineId?: string })[], previous: ReadonlySet<ThreadId>): RemoteChildSet {
  const wanted = new Map<ThreadId, Thread>()
  // The bare copy `live.ts` keeps of a child another machine started here (no parent) gives way to the nested one.
  for (const child of remote) if (isChildThread(child) && !(current[child.id] && !previous.has(child.id) && !isRemoteChildThread(current[child.id]))) wanted.set(child.id, child)
  let next: Record<ThreadId, Thread> | null = null
  const edit = () => (next ??= { ...current })
  for (const id of previous) if (!wanted.has(id) && current[id]) delete edit()[id]
  for (const [id, child] of wanted) if (current[id] !== child) edit()[id] = child
  return { ids: new Set(wanted.keys()), children: next }
}

/**
 * The machine of the thread a child was started by, for "Open parent": the origin's for a child another machine's thread
 * started, else the child's own (a subagent or delegated child runs where its parent does). Undefined when unknown.
 */
export function parentMachineOf(child: Thread & { machineId?: MachineId }): MachineId | undefined {
  const origin = child.origin
  return child.delegation && origin?.thread_id && origin.thread_id === child.parent_thread_id ? origin.machine_id : child.machineId
}

const nested = new WeakMap<Thread, { parentId: ThreadId; projectId: string; result: StateThread }>()

/**
 * Children started by a thread on another machine, nested under it: `parent_thread_id` is that thread (their `origin`) and
 * `project_id` the row it is listed in, when it is listed (`ownProjectId` keeps their own). Every other child is returned
 * as it is; nested copies are memoized per source object, so an unchanged child keeps its identity.
 */
export function underParents(children: readonly StateThread[], threads: readonly StateThread[], localMachineId: MachineId): StateThread[] {
  let parents: Map<string, StateThread> | undefined
  return children.map((child) => {
    const origin = child.origin
    if (!child.delegation || !origin?.thread_id || origin.machine_id === (child.machineId ?? localMachineId)) return child
    parents ??= new Map(threads.map((thread) => [scopedKey(thread.machineId ?? localMachineId, thread.id), thread]))
    const parentId = origin.thread_id
    const projectId = parents.get(scopedKey(origin.machine_id, parentId))?.project_id ?? child.project_id
    if (child.parent_thread_id === parentId && child.project_id === projectId) return child
    const old = nested.get(child)
    if (old && old.parentId === parentId && old.projectId === projectId) return old.result
    const own = child.ownProjectId ?? child.project_id
    const result: StateThread = { ...child, parent_thread_id: parentId, project_id: projectId, ...(own !== projectId ? { ownProjectId: own } : {}) }
    nested.set(child, { parentId, projectId, result })
    return result
  })
}

/** Children another machine's threads started on the machine the user is at, from its lists and live events. */
export class OriginChildren {
  private readonly threads = new Map<ThreadId, Thread>()
  private snapshot: readonly Thread[] = []
  private stale = false

  get list(): readonly Thread[] {
    if (this.stale) { this.stale = false; this.snapshot = [...this.threads.values()] }
    return this.snapshot
  }

  /** A full `threads.list` read: it lists them all. A newer copy from an event that raced the read stays. */
  replace(threads: readonly Thread[]): boolean {
    const next = new Map<ThreadId, Thread>()
    for (const thread of threads) {
      if (!isRemoteChildThread(thread) || thread.status === 'archived') continue
      const current = this.threads.get(thread.id)
      next.set(thread.id, current && current.last_seq > thread.last_seq ? current : thread)
    }
    const same = next.size === this.threads.size && [...next].every(([id, thread]) => this.threads.get(id) === thread)
    if (same) return false
    this.threads.clear()
    for (const [id, thread] of next) this.threads.set(id, thread)
    this.stale = true
    return true
  }

  /** `thread_created` / `thread_updated`; an archived thread leaves. Returns whether something changed. */
  put(thread: Thread): boolean {
    if (!isRemoteChildThread(thread)) return false
    if (thread.status === 'archived') return this.remove(thread.id)
    const current = this.threads.get(thread.id)
    if (current === thread || (current && current.last_seq > thread.last_seq)) return false
    this.threads.set(thread.id, thread)
    this.stale = true
    return true
  }

  remove(id: ThreadId): boolean {
    if (!this.threads.delete(id)) return false
    this.stale = true
    return true
  }
}

/** The children of other machines' threads, as their machines report them (own project ids, no `machineId`). */
export class RemoteChildStore {
  private readonly byMachine = new Map<MachineId, Map<ThreadId, Thread>>()
  /** Archived here: a late `thread_updated` must not bring the row back. */
  private readonly archived = new Map<MachineId, Set<ThreadId>>()
  private snapshot: ReadonlyMap<MachineId, readonly Thread[]> = new Map()
  private stale = false
  private readonly listeners = new Set<() => void>()

  /** Every machine's children; the same object until something changes. */
  get(): ReadonlyMap<MachineId, readonly Thread[]> {
    if (this.stale) {
      this.stale = false
      const next = new Map<MachineId, readonly Thread[]>()
      for (const [machineId, children] of this.byMachine) if (children.size) next.set(machineId, [...children.values()])
      this.snapshot = next
    }
    return this.snapshot
  }

  /** A read or an event of one machine. Older copies (`last_seq`) and threads that are no children change nothing. */
  put(machineId: MachineId, threads: readonly Thread[]): boolean {
    let changed = false
    for (const thread of threads) {
      if (!isChildThread(thread) || !thread.parent_thread_id) continue
      const gone = this.archived.get(machineId)
      if (thread.status === 'archived') { changed = this.remove(machineId, thread.id, false) || changed; continue }
      if (gone?.has(thread.id)) continue
      let children = this.byMachine.get(machineId)
      const current = children?.get(thread.id)
      if (current === thread || (current && current.last_seq > thread.last_seq)) continue
      if (!children) this.byMachine.set(machineId, children = new Map())
      children.set(thread.id, thread)
      changed = true
    }
    if (changed) this.changed()
    return changed
  }

  /** `thread_archived` on a machine. */
  remove(machineId: MachineId, id: ThreadId, notify = true): boolean {
    let gone = this.archived.get(machineId)
    if (!gone) this.archived.set(machineId, gone = new Set())
    gone.add(id)
    if (!this.byMachine.get(machineId)?.delete(id)) return false
    if (notify) this.changed()
    return true
  }

  /** A machine that left the network takes its children along. */
  dropMachine(machineId: MachineId) {
    this.archived.delete(machineId)
    if (this.byMachine.delete(machineId)) this.changed()
  }

  machines(): MachineId[] { return [...this.byMachine.keys()] }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  clear() {
    this.archived.clear()
    if (!this.byMachine.size) return
    this.byMachine.clear()
    this.changed()
  }

  private changed() {
    this.stale = true
    for (const listener of [...this.listeners]) listener()
  }
}

/** The app's store: `nav/live.ts` fills it through `RemoteLive`, `state.ts` merges it into `nav.children`. */
export const remoteChildStore = new RemoteChildStore()
