// GPUIX's machine set (design §5.2, steps 1 and 2).
//
// The hub owns a `MachineSet` and the seams between it and the app as it is:
//
// - The daemon connection `state.ts` opens (the active environment) is the
//   "primary" machine, the one the user is at. It joins the set once the daemon
//   has answered and its machine id is known, as a connection the set adopts but
//   does not own, so its socket, status details and reconnects stay exactly as
//   they were and the set never reads lists the app already has.
// - Saved machines are loaded as records (`store.ts`). With one machine the app
//   opens the same single socket it always did and nothing else is dialed.
// - Other machines (connected by the set itself) are read by the set and their
//   lists merged with the primary's: `state.ts` shows the merged view.
//
// The set connects the other machines itself (`connectOthers`: saved machines
// and the rest of the network, learned from the primary when the daemon is a
// member). The app keeps opening its own socket to the machine the user is at.
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
import { NETWORK_FEATURES, type MachineId, type Project, type Thread, type ThreadActivitySummary } from '../../../../packages/kybern-client/src/types.ts'
import { verifyMachineProof } from './proof.ts'
import { createGpuixSocket } from './socket.ts'
import { isLegacyMachineId } from './records.ts'

export interface PrimaryProfile { id: string; name: string }

export interface MachineHubOptions {
  /** The saved machines, as records. Read once, when the set loads. */
  records: () => MachineRecord[] | Promise<MachineRecord[]>
  /** Where the set saves its records (default: nowhere). */
  save?: (records: MachineRecord[]) => void | Promise<void>
  /** A saved environment's device token, by profile id (`records.ts` stand-ins). */
  readCredential?: (profileId: string) => Promise<string>
  /** The set's credential store (default: reads `readCredential` by the record's profile id, writes nothing). */
  credentials?: CredentialStore
  /** The offline cache (default: in memory). */
  cache?: MachineCache
  /** Before any machine is dialed: a tunnel for a saved SSH machine, say. Failures never stop the others. */
  prepare?: (record: MachineRecord) => void | Promise<void>
  /** A saved profile's token was replaced by `machine:<id>`: drop the old one. */
  forgetProfile?: (profileId: string) => void | Promise<void>
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
  /** The set has this client as the machine's connection. */
  adopted?: boolean
  /** The set got the first lists of this connection (later ones wait until something reads them). */
  listed?: boolean
}

interface PrimaryLists { owner: KybernClient; projects: Project[]; threads: Thread[]; activity?: ThreadActivitySummary[]; ingested: boolean }

const LIVE = new Set(['online', 'relaying', 'needs-update'])

export class MachineHub {
  readonly set: MachineSet
  private readonly options: MachineHubOptions
  private primary: Primary | null = null
  private lists: PrimaryLists | null = null
  /** Every machine id that has been the primary in this run: the app's own socket carries it, the set never dials it. */
  private readonly adopted = new Set<MachineId>()
  private readonly watched = new Set<MachineId>()
  private readonly refreshes = new Map<MachineId, boolean>()
  private readonly listeners = new Set<() => void>()
  /** Told when the machines or their status change (not when lists do); watching is free. */
  private readonly machineListeners = new Set<() => void>()
  private flushTimer: unknown
  private disposed = false

  constructor(options: MachineHubOptions) {
    this.options = options
    const store: MachineStore = {
      load: async () => {
        const records = await options.records()
        // A machine the app dials needs its tunnel first (a saved SSH machine).
        if (options.prepare) await Promise.all(records.map((record) => Promise.resolve(options.prepare!(record)).catch(() => {})))
        return records
      },
      save: (records) => options.save?.(records),
    }
    this.set = new MachineSet({
      store,
      credentials: options.credentials ?? this.credentials(),
      deviceId: options.deviceId ?? 'gpuix-desktop',
      verifyProof: verifyMachineProof,
      cache: options.cache ?? new MachineCache(),
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
    await this.set.load()
    // The saved record of this profile had a stand-in id until the daemon answered: it becomes the daemon's id.
    for (const other of this.set.connections()) {
      const record = other.record
      if (record.legacyProfileId !== primary.profile.id || record.machineId === machineId || !isLegacyMachineId(record.machineId)) continue
      if (this.set.connection(machineId)) await this.set.removeMachine(record.machineId)
      else await this.set.rekeyMachine(record.machineId, machineId)
      await this.forgetProfile(record.legacyProfileId)
    }
    if (this.primary?.client !== client || this.disposed) return
    // A daemon with the network on is a member: the set learns the other machines from it.
    const member = await this.isMember(client)
    if (this.primary?.client !== client || this.disposed) return
    // The set never dials this machine and never reads its lists: the app's socket is the connection and `ingestPrimary` hands over the lists.
    await this.set.adoptConnection({
      machineId,
      name: primary.profile.name,
      member,
      paused: false,
      legacyProfileId: primary.profile.id,
    }, client, { autoRefresh: false })
    if (this.primary?.client !== client) return
    primary.adopted = true
    // The set starts with the lists the app already read, as it did when it read them through the app's client.
    this.ingestNow(primary)
    this.set.setLocalMachine(machineId)
    this.watchOthers()
    this.scheduleFlush()
    // The rest of the network and the saved machines, in the background: the app already works.
    void this.connectOthers().catch(() => {})
  }

  /** Connect every machine but the primary and read their lists (idempotent while the set is loaded). */
  async connectOthers(): Promise<void> {
    if (this.disposed) return
    await this.set.ensureAll()
    this.watchOthers()
    await this.rekeyLegacy()
  }

  /** Does the daemon at `client` belong to a machine network (so it can name the other machines)? */
  private async isMember(client: KybernClient): Promise<boolean> {
    if (client.info?.features && !client.info.features.includes(NETWORK_FEATURES.network)) return false
    try {
      const status = await client.call('network.status', {})
      return !!status.enabled
    } catch {
      return false
    }
  }

  private async forgetProfile(profileId: string | undefined) {
    // The local daemon has no saved token: its credentials are the data folder's files.
    if (!profileId || profileId === 'local' || !this.options.forgetProfile) return
    try { await this.options.forgetProfile(profileId) } catch { /* the token is unused once the record moved */ }
  }

  /** A saved machine that answered: its stand-in id becomes the daemon's. */
  private async rekeyLegacy(): Promise<void> {
    for (const connection of this.set.connections()) {
      const record = connection.record
      const id = connection.info?.machine_id || connection.info?.environment_id
      if (!isLegacyMachineId(record.machineId) || !id || id === record.machineId) continue
      try {
        if (this.set.connection(id)) await this.set.removeMachine(record.machineId)
        else await this.set.rekeyMachine(record.machineId, id)
        await this.forgetProfile(record.legacyProfileId)
      } catch { /* retried when it answers again */ }
    }
  }

  /** The primary client was closed (an environment switch, a reconnect from scratch). */
  releasePrimary() {
    const primary = this.primary
    if (!primary) return
    this.primary = null
    this.lists = null
    this.cancelFlush()
    // Paused, so the set does not retry a socket that only the app can open.
    if (primary.machineId) void this.set.setPaused(primary.machineId, true)
  }

  /** The primary's lists reach the set now, not after the delay (`state.ts` is about to read the merged view). */
  ingestPrimaryNow() {
    if (this.primary) this.ingestNow(this.primary)
  }

  /** The lists `state.ts` just read from the primary daemon (all threads, children and archived included). */
  ingestPrimary(client: KybernClient, projects: Project[], threads: Thread[], activity?: ThreadActivitySummary[]) {
    if (this.primary?.client !== client) return
    this.lists = { owner: client, projects, threads, ...(activity ? { activity } : {}), ingested: false }
    if (this.primary.adopted && !this.primary.listed) this.ingestNow(this.primary)
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

  /** Machines and statuses only. Unlike `subscribe` it never makes the hub keep the merged lists. */
  onMachinesChanged(listener: () => void): () => void {
    this.machineListeners.add(listener)
    return () => { this.machineListeners.delete(listener) }
  }

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
    this.set.dispose()
    this.listeners.clear()
    this.machineListeners.clear()
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
    if (this.options.transport?.createClient) return this.options.transport.createClient(args)
    const legacy = isLegacyMachineId(record.machineId)
    return new KybernClient(
      { url: normalizeDaemonUrl(route.url), token, ...(legacy ? {} : { environmentId: record.machineId }) },
      { createSocket: createGpuixSocket, ...(legacy ? {} : { expectedEnvironmentId: record.machineId }) },
    )
  }

  private onSetChange(event: MachineSetEvent) {
    if (event.type === 'records' || event.type === 'status') {
      this.watchOthers()
      this.scheduleFlush()
      if (event.type === 'status') void this.rekeyLegacy().catch(() => {})
      for (const listener of [...this.machineListeners]) listener()
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
      const refresh = () => void this.refreshMachine(id).catch(() => {})
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
      if (this.primary) this.ingestNow(this.primary)
    }, this.options.ingestDelayMs ?? 300)
  }

  private ingestNow(primary: Primary) {
    const lists = this.lists
    if (!lists || lists.ingested || !primary.machineId || primary.client !== lists.owner) return
    lists.ingested = true
    primary.listed = true
    this.set.ingest(primary.machineId, { projects: lists.projects, threads: lists.threads, ...(lists.activity ? { activity: lists.activity } : {}) })
  }
}
