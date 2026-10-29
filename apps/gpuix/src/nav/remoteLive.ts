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
//   for the local daemon.
//
// With one machine nothing here runs: the hub opens no stream and the activity
// maps stay empty. Nav maps are keyed by thread id, as for local threads; a
// local thread of the same id wins.
import { pendingOf } from '../../../../packages/kybern-client/src/threadAttention.ts'
import type { MachineHub } from '../machines/hub.ts'
import type { MachineId, ThreadActivitySummary, ThreadEvent, ThreadId } from '../../../../packages/kybern-client/src/types.ts'
import type { NavState } from './store.ts'

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
  hub: Pick<MachineHub, 'set' | 'localMachineId' | 'machineCount' | 'onMachineEvent' | 'onMachinesChanged' | 'subscribe' | 'refreshMachineLists' | 'connections'>
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
  }

  private onEvent(machineId: MachineId, event: ThreadEvent) {
    const { set } = this.deps.hub
    switch (event.kind) {
      case 'thread_created':
      case 'thread_updated':
        set.patchThread(machineId, event.thread)
        return
      case 'thread_archived':
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
      case 'approval_requested':
      case 'user_input_requested':
      case 'approval_resolved':
      case 'runtime_task_started':
      case 'runtime_task_updated':
      case 'runtime_task_completed':
        this.scheduleRead(machineId)
        return
    }
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
