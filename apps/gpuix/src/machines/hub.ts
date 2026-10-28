// GPUIX's machine set (design §5.2, steps 1 and 2).
//
// The hub owns a `MachineSet` and the seams between it and the app as it is:
//
// - The daemon connection `state.ts` opens (the active environment) is the
//   "primary" machine, the one the user is at. It joins the set once the daemon
//   has answered and its machine id is known, through `ForwardedClient`, so its
//   socket, status details and reconnects stay exactly as they were.
// - Saved environments are loaded as machine records (`records.ts`) but are NOT
//   connected: with one environment in use the app opens the same single socket
//   it always did.
// - Other machines (connected by the set itself) are read by the set and their
//   lists merged with the primary's. Nothing in the UI reads the merged view yet.
//
// TODO(N6 steps 3-5): thread-scoped code asks `clientForThread`/`clientForProject`
// instead of `getClient()`, the sidebar reads `useMachineView()`, the set calls
// `ensureAll()` and opens the primary socket itself, and the environment switch
// and per-environment windows go away.
import { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
import { normalizeDaemonUrl } from '../../../../packages/kybern-client/src/address.ts'
import { MachineCache } from '../../../../packages/kybern-client/src/machineCache.ts'
import {
  MachineSet,
  UnknownMachineError,
  type Clock,
  type CredentialStore,
  type MachineConnection,
  type MachineRecord,
  type MachineSetEvent,
  type MachineStore,
  type MachineTransport,
  type MergedView,
} from '../../../../packages/kybern-client/src/machines.ts'
import type { MachineId, Project, Thread } from '../../../../packages/kybern-client/src/types.ts'
import { ForwardedClient, type ListSource } from './forwarded.ts'
import { verifyMachineProof } from './proof.ts'
import { createGpuixSocket } from './socket.ts'
import { isLegacyMachineId } from './records.ts'

export interface PrimaryProfile { id: string; name: string }

export interface MachineHubOptions {
  /** The saved machines, as records. Read once, when the set loads. */
  records: () => MachineRecord[]
  /** A saved environment's device token, by profile id. */
  readCredential?: (profileId: string) => Promise<string>
  /** This device's id for `network.client_grant`. */
  deviceId?: string
  /** Replaces the sockets of non-primary machines (tests). */
  transport?: Partial<MachineTransport>
  clock?: Clock
  /** Delay before the primary's lists reach the set (default 300 ms); one write per burst of `threads.changed`. */
  ingestDelayMs?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

interface Primary {
  client: KybernClient
  profile: PrimaryProfile
  machineId?: MachineId
}

interface PrimaryLists { owner: KybernClient; projects: Project[]; threads: Thread[]; ingested: boolean }

const PRIMARY_TOKEN = 'adopted'
const LIVE = new Set(['online', 'relaying', 'needs-update'])

export class MachineHub {
  readonly set: MachineSet
  private readonly options: MachineHubOptions
  private primary: Primary | null = null
  private lists: PrimaryLists | null = null
  private readonly waiters = new Set<() => void>()
  /** Every machine id that has been the primary in this run: only the primary's own socket may carry it. */
  private readonly adopted = new Set<MachineId>()
  private readonly watched = new Set<MachineId>()
  private readonly refreshes = new Map<MachineId, boolean>()
  private readonly listeners = new Set<() => void>()
  private flushTimer: unknown
  private disposed = false

  constructor(options: MachineHubOptions) {
    this.options = options
    const store: MachineStore = {
      load: () => options.records(),
      // TODO(N6 step 5): persist `machines.json` and migrate `environments.json`.
      save: () => {},
    }
    this.set = new MachineSet({
      store,
      credentials: this.credentials(),
      deviceId: options.deviceId ?? 'gpuix-desktop',
      verifyProof: verifyMachineProof,
      // TODO(N6 step 4): a MachineCache over a file in the client config dir, for "Offline · last seen".
      cache: new MachineCache(),
      socket: createGpuixSocket,
      transport: { ...options.transport, createClient: (args) => this.createClient(args) },
      ...(options.clock ? { clock: options.clock } : {}),
    })
    this.set.onChange((event) => this.onSetChange(event))
  }

  // ---- the primary: the connection state.ts owns ----

  /** `state.ts` built a client for the active environment. */
  beginPrimary(client: KybernClient, profile: PrimaryProfile) {
    this.primary = { client, profile }
    this.lists = null
  }

  /** The primary client opened: join the set under the daemon's machine id. */
  async primaryOpened(client: KybernClient): Promise<void> {
    const primary = this.primary
    if (!primary || primary.client !== client || this.disposed) return
    const info = client.info
    const machineId = info?.machine_id || info?.environment_id
    if (!machineId) return
    // A reconnect of the same daemon: the set already follows the client's own status.
    if (primary.machineId === machineId && this.set.connection(machineId)?.status !== 'paused') return
    primary.machineId = machineId
    this.adopted.add(machineId)
    await this.set.addMachine({
      machineId,
      name: primary.profile.name,
      // The set never dials this route: the forwarded client is the connection.
      routes: [{ kind: 'direct_advertised', url: 'http://127.0.0.1' }],
      member: false,
      paused: false,
      legacyProfileId: primary.profile.id,
    })
    if (this.primary?.client !== client) return
    // The saved record of this profile had a stand-in id until the daemon answered.
    for (const other of this.set.connections()) {
      const record = other.record
      if (record.legacyProfileId === primary.profile.id && record.machineId !== machineId && isLegacyMachineId(record.machineId)) await this.set.removeMachine(record.machineId)
    }
    this.set.setLocalMachine(machineId)
    this.watchOthers()
    this.scheduleFlush()
  }

  /** The primary client was closed (an environment switch, a reconnect from scratch). */
  releasePrimary() {
    const primary = this.primary
    if (!primary) return
    this.primary = null
    this.lists = null
    this.cancelFlush()
    for (const wake of [...this.waiters]) wake()
    // Paused, so the set does not retry a socket that only the app can open.
    if (primary.machineId) void this.set.setPaused(primary.machineId, true)
  }

  /** The lists `state.ts` just read from the primary daemon (all threads, children and archived included). */
  ingestPrimary(client: KybernClient, projects: Project[], threads: Thread[]) {
    if (this.primary?.client !== client) return
    this.lists = { owner: client, projects, threads, ingested: false }
    for (const wake of [...this.waiters]) wake()
    this.scheduleFlush()
  }

  // ---- reading ----

  /** The machine the user is at: where `getClient()` points. */
  get localMachineId(): MachineId | undefined { return this.set.localMachineId }
  get primaryClient(): KybernClient | null { return this.primary?.client ?? null }

  /** More than one machine is known: today only a saved environment that is not the active one. */
  get machineCount(): number { return this.set.connections().length }

  /** The merged lists of every machine. Stable between changes. */
  view(): MergedView {
    return this.set.merged()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    this.scheduleFlush()
    return () => { this.listeners.delete(listener) }
  }

  connections(): readonly MachineConnection[] { return this.set.connections() }

  /** A machine's client (throws `OfflineError` while it cannot be reached). */
  clientFor(machineId: MachineId): KybernClient {
    return this.set.clientFor(machineId)
  }

  /**
   * The client of the machine that owns a thread. Thread ids are unique per
   * machine only, so pass `machineId` when the caller has it; an unlisted thread
   * (a new chat) belongs to the machine the user is at.
   */
  clientForThread(threadId: string, machineId?: MachineId): KybernClient {
    return this.set.clientFor(machineId ?? this.set.machineOfThread(threadId) ?? this.requireLocal())
  }

  /** The client of the machine that owns a project instance; `machineId` picks one of several checkouts. */
  clientForProject(projectId: string, machineId?: MachineId): KybernClient {
    return this.set.clientFor(machineId ?? this.set.machineOfProject(projectId) ?? this.requireLocal())
  }

  machineOfThread(threadId: string, hint?: MachineId): MachineId | undefined {
    return this.set.machineOfThread(threadId, hint) ?? this.set.localMachineId
  }

  dispose() {
    this.disposed = true
    this.cancelFlush()
    for (const wake of [...this.waiters]) wake()
    this.set.dispose()
    this.listeners.clear()
  }

  // ---- internals ----

  private requireLocal(): MachineId {
    const id = this.set.localMachineId
    if (!id) throw new UnknownMachineError('local')
    return id
  }

  private credentials(): CredentialStore {
    const profileOf = (machineId: MachineId) => this.set.connection(machineId)?.record.legacyProfileId
    return {
      get: async (machineId) => {
        if (this.adopted.has(machineId)) return PRIMARY_TOKEN
        const profile = profileOf(machineId)
        if (!profile || !this.options.readCredential) return undefined
        try { return await this.options.readCredential(profile) } catch { return undefined }
      },
      // The registry and credential store stay as they are until the migration (step 5).
      set: () => {},
      delete: () => {},
    }
  }

  private createClient(args: Parameters<MachineTransport['createClient']>[0]) {
    const { record, route, token } = args
    const primary = this.primary
    if (this.adopted.has(record.machineId)) {
      if (primary?.machineId !== record.machineId) throw new Error('Reconnecting')
      return new ForwardedClient(primary.client, this.listSource(primary))
    }
    if (this.options.transport?.createClient) return this.options.transport.createClient(args)
    const legacy = isLegacyMachineId(record.machineId)
    return new KybernClient(
      { url: normalizeDaemonUrl(route.url), token, ...(legacy ? {} : { environmentId: record.machineId }) },
      { createSocket: createGpuixSocket, ...(legacy ? {} : { expectedEnvironmentId: record.machineId }) },
    )
  }

  private listSource(primary: Primary): ListSource {
    return {
      read: (signal) => new Promise((resolve, reject) => {
        const settle = () => {
          if (signal.aborted || this.primary !== primary) { cleanup(); reject(new Error('Closed')); return true }
          if (this.lists?.owner === primary.client) { cleanup(); resolve(this.lists); return true }
          return false
        }
        const cleanup = () => { this.waiters.delete(settle); signal.removeEventListener('abort', settle) }
        if (settle()) return
        this.waiters.add(settle)
        signal.addEventListener('abort', settle)
      }),
    }
  }

  private onSetChange(event: MachineSetEvent) {
    if (event.type === 'records' || event.type === 'status') {
      this.watchOthers()
      this.scheduleFlush()
    }
    for (const listener of [...this.listeners]) listener()
  }

  /** Lists changed on a machine the set connects itself: read that machine again (state.ts does it for the primary). */
  private watchOthers() {
    for (const connection of this.set.connections()) {
      const id = connection.record.machineId
      if (this.watched.has(id) || this.adopted.has(id) || (connection.record.legacyProfileId && isLegacyMachineId(id))) continue
      this.watched.add(id)
      const handle = this.set.handleFor(id)
      const refresh = () => void this.refreshMachine(id)
      handle.onNotification('projects.changed', refresh)
      handle.onNotification('threads.changed', refresh)
    }
  }

  /** One read per machine at a time; a change that arrives during a read folds into one rerun. */
  private async refreshMachine(id: MachineId): Promise<void> {
    if (this.refreshes.has(id)) { this.refreshes.set(id, true); return }
    this.refreshes.set(id, false)
    try {
      do {
        this.refreshes.set(id, false)
        await this.set.refresh(id)
      } while (this.refreshes.get(id) && !this.disposed)
    } finally {
      this.refreshes.delete(id)
    }
  }

  // The set caches and merges whatever it is given. With one machine and nothing
  // watching the merged view that work has no reader, so the primary's lists wait
  // (by reference) until a second machine is live or a view subscribes.
  private wanted(): boolean {
    if (this.listeners.size > 0) return true
    let live = 0
    for (const connection of this.set.connections()) if (LIVE.has(connection.status)) live++
    return live > 1
  }

  private cancelFlush() {
    if (this.flushTimer === undefined) return
    if (this.options.clearTimer) this.options.clearTimer(this.flushTimer)
    else clearTimeout(this.flushTimer as ReturnType<typeof setTimeout>)
    this.flushTimer = undefined
  }

  private scheduleFlush() {
    if (this.flushTimer !== undefined || this.disposed || !this.lists || this.lists.ingested || !this.primary?.machineId || !this.wanted()) return
    const setTimer = this.options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.flushTimer = setTimer(() => {
      this.flushTimer = undefined
      const lists = this.lists, primary = this.primary
      if (!lists || lists.ingested || !primary?.machineId || primary.client !== lists.owner) return
      lists.ingested = true
      this.set.ingest(primary.machineId, { projects: lists.projects, threads: lists.threads })
    }, this.options.ingestDelayMs ?? 300)
  }
}
