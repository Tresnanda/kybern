// Keeps the threads of the other machines as live as the local ones (design §5.2).
//
// `live.ts` follows the daemon the user is at. A thread on another machine would
// keep whatever the last list read said (a "working" glyph after its turn ended)
// because that machine's events never reached the app. Here the hub's per-machine
// event streams (`MachineHub.onMachineEvent`) feed the same rules:
//
// - `thread_created` / `thread_updated` / `thread_archived` patch the machine's
//   list in the set, so the merged row keeps its machine, project and identity;
// - a finished turn nobody is reading marks the thread unread;
// - requests and runtime tasks re-read that machine's lists shortly after (its
//   activity: working, monitoring and the pending badge), like `live.ts` does
//   for the local daemon;
// - a thread's subagents and delegated children, which `threads.list` leaves
//   out, are read from its machine while it has agents at work or is open, and
//   then follow that machine's events (`RemoteChildStore`).
//
// With one machine nothing here runs: the hub opens no stream and the activity
// maps stay empty. Nav maps are keyed by thread id, as for local threads; a
// local thread of the same id wins.
import { pendingOf } from '../../../../packages/kybern-client/src/threadAttention.ts'
import { isChildThread } from '../../../../packages/kybern-client/src/subagents.ts'
import { scopedKey } from '../../../../packages/kybern-client/src/machineMerge.ts'
import type { MachineHub } from '../machines/hub.ts'
import type { MachineId, ThreadActivitySummary, ThreadEvent, ThreadId } from '../../../../packages/kybern-client/src/types.ts'
import type { NavState } from './store.ts'
import type { RemoteChildStore } from './remoteChildren.ts'

const ACTIVITY_DEBOUNCE_MS = 600

/** What the sidebar shows per thread, from a machine's `threads.list` activity. */
export function activityMaps(summaries: readonly ThreadActivitySummary[] | undefined): { activity: NavState['activity']; pending: NavState['pending'] } {
  const activity: NavState['activity'] = {}
  const pending: NavState['pending'] = {}
  for (const summary of summaries ?? []) {
    if (summary.state) activity[summary.thread_id] = summary.state
    const waiting = pendingOf(summary)
    if (waiting) pending[summary.thread_id] = waiting
  }
  return { activity, pending }
}

/** Local entries win: a remote thread that shares an id with a local one never shows the local thread's state. */
export function withRemote<T>(local: Record<ThreadId, T>, remote: Record<ThreadId, T>): Record<ThreadId, T> {
  for (const id in remote) if (!(id in local)) return { ...remote, ...local }
  return local
}

export interface RemoteLiveDeps {
  hub: Pick<MachineHub, 'set' | 'localMachineId' | 'machineCount' | 'onMachineEvent' | 'onMachinesChanged' | 'subscribe' | 'refreshMachineLists' | 'connections' | 'clientFor'>
  /** Where the other machines' threads' children go (`nav/remoteChildren.ts`). */
  children: RemoteChildStore
  /** Threads as the app lists them, and the selected one. */
  state: () => { threads: readonly { id: ThreadId; machineId?: MachineId; parent_thread_id?: string | null }[]; selectedId: ThreadId | null; selectedMachineId?: MachineId }
  unread: () => NavState['unread']
  setUnread: (unread: NavState['unread']) => void
  /** The remote activity changed: `live.ts` publishes it with the local one. */
  publish: () => void
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

const LIVE = new Set(['online', 'relaying', 'needs-update'])

export class RemoteLive {
  /** The activity of the other machines, by thread id. */
  activity: NavState['activity'] = {}
  pending: NavState['pending'] = {}
  private readonly reads = new Map<MachineId, unknown>()
  private readonly seen = new Map<MachineId, readonly ThreadActivitySummary[] | undefined>()
  private readonly childLoads = new Map<string, Promise<void>>()
  private stops: (() => void)[] = []
  private viewStop: (() => void) | undefined
  private disposed = false

  constructor(private readonly deps: RemoteLiveDeps) {}

  start() {
    const { hub } = this.deps
    this.stops.push(hub.onMachineEvent((machineId, event) => this.onEvent(machineId, event)))
    // The merged lists are read only while another machine is known; one machine costs nothing here.
    const sync = () => {
      const several = hub.machineCount > 1
      if (several && !this.viewStop) this.viewStop = hub.subscribe(() => this.readActivity())
      if (!several && this.viewStop) { this.viewStop(); this.viewStop = undefined }
      const withChildren = this.deps.children.machines()
      if (withChildren.length) {
        const known = new Set(hub.connections().map((connection) => connection.record.machineId))
        for (const id of withChildren) if (!known.has(id)) this.deps.children.dropMachine(id)
      }
      this.readActivity()
    }
    this.stops.push(hub.onMachinesChanged(sync), () => { this.viewStop?.(); this.viewStop = undefined })
    sync()
  }

  stop() {
    this.disposed = true
    for (const stop of this.stops) stop()
    this.stops = []
    for (const handle of this.reads.values()) (this.deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(handle)
    this.reads.clear()
    this.childLoads.clear()
  }

  private onEvent(machineId: MachineId, event: ThreadEvent) {
    const { set } = this.deps.hub
    switch (event.kind) {
      case 'thread_created':
      case 'thread_updated':
        if (isChildThread(event.thread) && event.thread.parent_thread_id) this.deps.children.put(machineId, [event.thread])
        set.patchThread(machineId, event.thread)
        return
      case 'thread_archived':
        this.deps.children.remove(machineId, event.thread_id)
        set.removeThread(machineId, event.thread_id)
        return
      case 'turn_completed': {
        // A finished turn the reader did not watch (the same rule as `live.ts`).
        if (event.stop_reason !== 'completed') return
        const state = this.deps.state()
        const thread = state.threads.find((t) => t.id === event.thread_id && t.machineId === machineId)
        if (!thread || thread.parent_thread_id) return
        if (state.selectedId === event.thread_id && state.selectedMachineId === machineId) return
        const unread = this.deps.unread()
        if (!unread[event.thread_id]) this.deps.setUnread({ ...unread, [event.thread_id]: true })
        return
      }
      case 'runtime_task_started':
        if (event.task.kind === 'agent') void this.loadChildren(machineId, event.thread_id)
        this.scheduleRead(machineId)
        return
      case 'approval_requested':
      case 'user_input_requested':
      case 'approval_resolved':
      case 'runtime_task_updated':
      case 'runtime_task_completed':
        this.scheduleRead(machineId)
        return
    }
  }

  /** A thread's subagent and delegated children, read from the machine that owns it (`live.ts` `loadChildren`). */
  loadChildren(machineId: MachineId, parentId: ThreadId): Promise<void> {
    if (this.disposed || machineId === this.deps.hub.localMachineId) return Promise.resolve()
    const key = scopedKey(machineId, parentId)
    const pending = this.childLoads.get(key)
    if (pending) return pending
    let client: ReturnType<RemoteLiveDeps['hub']['clientFor']>
    try { client = this.deps.hub.clientFor(machineId) } catch { return Promise.resolve() }
    const request = client
      .call('threads.list', { parent_thread_id: parentId })
      .then((result) => { if (!this.disposed) this.deps.children.put(machineId, result.threads) })
      .catch(() => {})
      .finally(() => this.childLoads.delete(key))
    this.childLoads.set(key, request)
    return request
  }

  /** One lists read per machine after a quiet moment: its activity comes with `threads.list`. */
  private scheduleRead(machineId: MachineId) {
    if (this.disposed) return
    const clear = this.deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
    const timer = this.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    const pending = this.reads.get(machineId)
    if (pending !== undefined) clear(pending)
    this.reads.set(machineId, timer(() => {
      this.reads.delete(machineId)
      void this.deps.hub.refreshMachineLists(machineId)
    }, ACTIVITY_DEBOUNCE_MS))
  }

  /** Rebuild the remote maps from the set; unchanged reads cost one comparison per machine. */
  private readActivity() {
    const { hub } = this.deps
    const local = hub.localMachineId
    let changed = false
    const live = new Set<MachineId>()
    for (const connection of hub.connections()) {
      const id = connection.record.machineId
      if (id === local || !LIVE.has(connection.status)) continue
      live.add(id)
      const summaries = hub.set.activityOf(id)
      if (this.seen.has(id) && this.seen.get(id) === summaries) continue
      this.seen.set(id, summaries)
      changed = true
      // Delegated children are no runtime tasks of their parent: they count in `active_children` (ADE-74).
      for (const summary of summaries ?? []) if (summary.active_agents > 0 || (summary.active_children ?? 0) > 0) void this.loadChildren(id, summary.thread_id)
    }
    for (const id of [...this.seen.keys()]) if (!live.has(id)) { this.seen.delete(id); changed = true }
    if (!changed) return
    const activity: NavState['activity'] = {}
    const pending: NavState['pending'] = {}
    for (const summaries of this.seen.values()) {
      const maps = activityMaps(summaries)
      Object.assign(activity, maps.activity)
      Object.assign(pending, maps.pending)
    }
    this.activity = activity
    this.pending = pending
    this.deps.publish()
  }
}
