// Trusted setup is separate from tailnet discovery. A discovery hint never becomes SSH authority.
import type { NetworkStatus } from '../../../../packages/kybern-client/src/types.ts'

export interface SetupClient {
  call(method: 'network.status', params: Record<string, never>): Promise<NetworkStatus>
  call(method: 'network.set_enabled', params: { enabled: boolean; only_if_unconfigured: boolean }): Promise<NetworkStatus>
}
/** Older daemons ignore unknown parameters: require the capability in their status first. */
export async function enableUnconfigured(client: SetupClient, signal?: AbortSignal): Promise<NetworkStatus> {
  signal?.throwIfAborted()
  const status = await client.call('network.status', {})
  signal?.throwIfAborted()
  if (status.removed) throw Error('This machine was removed from the network. Rejoin it from that machine before retrying.')
  if (status.enabled || status.configured === true) return status
  if (status.configured !== false) throw Error('Update Kybern on this machine, then retry. This version cannot preserve a previous off choice during automatic setup.')
  return client.call('network.set_enabled', { enabled: true, only_if_unconfigured: true })
}

export type SetupAccess = 'paired' | 'ssh' | 'guidance'
export interface SetupTarget {
  id: string
  name: string
  access: SetupAccess
  machineId?: string
  target?: string
  dataDir?: string
  online?: boolean
  address?: string
}
export type SetupPhase = 'queued' | 'checking' | 'installing' | 'starting' | 'pairing' | 'ready' | 'off' | 'install' | 'error' | 'access' | 'canceled'
export interface SetupRow { target: SetupTarget; phase: SetupPhase; detail: string; machineId?: string }
export interface SetupState { rows: SetupRow[]; discovering: boolean; error: string }
export interface SetupDependencies {
  discover(): Promise<SetupTarget[]>
  connect(target: SetupTarget, install: boolean, report: (phase: SetupPhase) => void, signal: AbortSignal): Promise<{ enabled: boolean; machineId?: string }>
  save?(rows: SetupRow[]): void
}
export const setupBusy = (phase: SetupPhase) => ['queued', 'checking', 'installing', 'starting', 'pairing'].includes(phase)
const detail = (phase: SetupPhase) => ({
  queued: 'Waiting to check saved access', checking: 'Checking saved access', installing: 'Installing the daemon and CLI',
  starting: 'Starting the persistent service', pairing: 'Connecting this device',
  ready: 'Network enabled. Machines on the same Tailscale account join automatically.',
  off: 'Network is off on this machine. Turn it on there to connect. Older saved off settings are kept off too.',
  install: 'Kybern is not installed. Install its daemon and CLI to connect.',
  access: 'Add a pairing invitation or save and verify an SSH connection to set up this machine.',
  error: 'Unable to connect. Check access and retry.', canceled: 'Setup canceled. Retry when you are ready.',
}[phase])

/** At most three tasks, one per target. Retry is explicit; restart never replays an installation. */
export class MachineSetup {
  private state: SetupState = { rows: [], discovering: false, error: '' }
  private listeners = new Set<() => void>()
  private jobs = new Map<string, { controller: AbortController; install: boolean; done: () => void; promise: Promise<void> }>()
  private queue: string[] = []
  private active = 0
  private discovery?: Promise<void>
  private generation = 0
  private discoveryGeneration = 0
  constructor(private deps: SetupDependencies, saved: SetupRow[] = []) {
    // A saved row is presentation only. Execution resolves it from fresh trusted inventory.
    this.state.rows = saved.slice(0, 64).map(row => setupBusy(row.phase) ? { ...row, phase: 'canceled', detail: detail('canceled') } : row)
  }
  get = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private emit(patch: Partial<SetupState>) {
    this.state = { ...this.state, ...patch }
    this.deps.save?.(this.state.rows)
    for (const listener of this.listeners) listener()
  }
  private update(id: string, phase: SetupPhase, message = detail(phase), machineId?: string) {
    this.emit({ rows: this.state.rows.map(row => row.target.id === id ? { ...row, phase, detail: message, ...(machineId ? { machineId } : {}) } : row) })
  }
  start(checkAgain = false): Promise<void> {
    if (this.discovery) {
      // Turning off cancels the old scan; turning back on before it settles must
      // start a fresh one rather than reuse the canceled generation.
      return checkAgain && this.discoveryGeneration !== this.generation
        ? this.discovery.then(() => this.start(true)) : this.discovery
    }
    const generation = this.generation
    this.discoveryGeneration = generation
    this.emit({ discovering: true, error: '' })
    const work = async () => {
      try {
        const targets = [...new Map((await this.deps.discover()).map(target => [target.id, target])).values()].slice(0, 64)
        if (generation !== this.generation) return
        const old = new Map(this.state.rows.map(row => [row.target.id, row]))
        this.emit({ rows: targets.map(target => ({ target, phase: target.access === 'guidance' ? 'access' : old.get(target.id)?.phase ?? 'queued', detail: target.access === 'guidance' ? detail('access') : old.get(target.id)?.detail ?? detail('queued'), machineId: old.get(target.id)?.machineId })), discovering: false })
        await Promise.all(targets.filter(target => target.access !== 'guidance' && (checkAgain || !old.has(target.id))).map(target => this.enqueue(target.id, false)))
      } catch (error) { this.emit({ error: error instanceof Error ? error.message : String(error) }) }
      finally { this.emit({ discovering: false }); this.discovery = undefined }
    }
    this.discovery = work()
    return this.discovery
  }
  async retry(id: string, install = false): Promise<void> {
    if (this.jobs.has(id)) return this.jobs.get(id)!.promise
    const generation = this.generation
    // Never execute a remembered target after its pairing/SSH alias was removed.
    const target = (await this.deps.discover()).find(target => target.id === id)
    if (generation !== this.generation) return
    if (!target || target.access === 'guidance') { this.update(id, 'access'); return }
    const row = this.state.rows.find(row => row.target.id === id)
    if (install && (!target.target || row?.phase !== 'install')) throw Error('Check this machine before installing Kybern.')
    this.emit({ rows: this.state.rows.map(row => row.target.id === id ? { ...row, target } : row) })
    return this.enqueue(id, install)
  }
  cancel(id: string) { this.jobs.get(id)?.controller.abort(); this.update(id, 'canceled') }
  cancelAll() { this.generation++; for (const id of this.jobs.keys()) this.cancel(id) }
  private enqueue(id: string, install: boolean): Promise<void> {
    const previous = this.jobs.get(id)
    if (previous) return previous.promise
    let done!: () => void
    const promise = new Promise<void>(resolve => { done = resolve })
    this.jobs.set(id, { controller: new AbortController(), install, done, promise })
    this.queue.push(id); this.update(id, 'queued'); this.pump()
    return promise
  }
  private pump() {
    while (this.active < 3 && this.queue.length) {
      const id = this.queue.shift()!, job = this.jobs.get(id)!
      const target = this.state.rows.find(row => row.target.id === id)?.target
      if (job.controller.signal.aborted || !target) { this.jobs.delete(id); job.done(); continue }
      this.active++
      this.update(id, 'checking')
      const timeout = setTimeout(() => {
        this.update(id, 'error', 'Setup timed out. Check the machine and its connection, then retry.')
        job.controller.abort()
      }, job.install ? 12 * 60_000 : 2 * 60_000)
      void Promise.resolve().then(() => {
        job.controller.signal.throwIfAborted()
        return this.deps.connect(target, job.install, phase => { if (!job.controller.signal.aborted) this.update(id, phase) }, job.controller.signal)
      }).then(result => {
        if (!job.controller.signal.aborted) this.update(id, result.enabled ? 'ready' : 'off', undefined, result.machineId)
      }, error => {
        if (job.controller.signal.aborted) return
        const phase = error instanceof Error && error.name === 'MissingDaemon' ? 'install' : 'error'
        this.update(id, phase, error instanceof Error ? error.message : String(error))
      }).finally(() => { clearTimeout(timeout); this.active--; this.jobs.delete(id); job.done(); this.pump() })
    }
  }
}
