// The phone's machine set (design §5.3), step 1: the hub around the existing
// single connection.
//
// - The connection `runtime.ts` opens (the active computer) is the "primary"
//   machine, the one the user is at. It joins the set under its machine id once
//   the daemon has answered, through `ForwardedClient`, so its socket, status,
//   reconnects and saved-credentials-before-socket rule stay exactly as they were.
// - Saved computers are loaded as machine records (`records.ts`) but are NOT
//   connected unless merged lists are enabled (`flag.ts`): with it off, one
//   computer or many, the app opens the same single socket it always did and
//   reads no list twice.
// - With merged lists on, the set connects the other machines itself, reads
//   their lists, and `view()` merges them with the primary's.
//
// TODO(N7 part 2): the Machines screen, the merged Home/Threads lists and the
// "All machines" filter read `view()`; thread-scoped code asks
// `clientForThread` instead of the active client; pairing calls
// `network.client_grant`; `connect(id)` becomes `ensureAll()` and the
// ComputerSwitcher goes away.
import { KybernClient, type ClientOptions } from "../../../../packages/kybern-client/src/client";
import { normalizeDaemonUrl } from "../../../../packages/kybern-client/src/address";
import { MachineCache } from "../../../../packages/kybern-client/src/machineCache";
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
  type SocketFactory,
} from "../../../../packages/kybern-client/src/machines";
import type { MachineId, Project, Thread } from "../../../../packages/kybern-client/src/types";
import { ForwardedClient, type ListSource } from "./forwarded";
import { verifyMachineProof } from "./proof";
import { isLegacyMachineId } from "./records";

export interface PrimaryProfile {
  /** The saved computer's id. */
  id: string;
  name: string;
}

export interface MachineHubOptions {
  /** The saved machines, as records. Read once, when the set loads. */
  records: () => MachineRecord[];
  /** A saved computer's device token, by its id. */
  readCredential?: (profileId: string) => string | undefined | Promise<string | undefined>;
  /** Merged lists are on: connect the other machines and merge their lists. Read at each use. */
  mergedLists: () => boolean;
  /** This device's id for `network.client_grant`. */
  deviceId?: string;
  /** The socket other machines open (the native one on a phone). */
  socket?: SocketFactory;
  /** Replaces the sockets of non-primary machines (tests). */
  transport?: Partial<MachineTransport>;
  clock?: Clock;
  /** Delay before the primary's lists reach the set (default 300 ms); one write per burst of changes. */
  ingestDelayMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface Primary {
  client: KybernClient;
  profile: PrimaryProfile;
  machineId?: MachineId;
}

interface PrimaryLists {
  owner: KybernClient;
  projects: Project[];
  threads: Thread[];
  ingested: boolean;
}

const PRIMARY_TOKEN = "adopted";
const LIVE = new Set(["online", "relaying", "needs-update"]);

export class MachineHub {
  readonly set: MachineSet;
  private readonly options: MachineHubOptions;
  private primary: Primary | null = null;
  private lists: PrimaryLists | null = null;
  private readonly waiters = new Set<() => void>();
  /** Every machine id that has been the primary in this run: only the primary's own socket may carry it. */
  private readonly adopted = new Set<MachineId>();
  private readonly watched = new Set<MachineId>();
  private readonly refreshes = new Map<MachineId, boolean>();
  private readonly listeners = new Set<() => void>();
  private flushTimer: unknown;
  private connecting: Promise<void> | undefined;
  private disposed = false;

  constructor(options: MachineHubOptions) {
    this.options = options;
    const store: MachineStore = {
      load: () => options.records(),
      // TODO(N7 part 2): persist `kybern.ink.machines` and migrate `kybern.ink.environments`.
      save: () => {},
    };
    this.set = new MachineSet({
      store,
      credentials: this.credentials(),
      deviceId: options.deviceId ?? "kybern-mobile",
      verifyProof: verifyMachineProof,
      // TODO(N7 part 2): a MachineCache over SecureStore/FileSystem for "Offline · last seen".
      cache: new MachineCache(),
      ...(options.socket ? { socket: options.socket } : {}),
      transport: { ...options.transport, createClient: (args) => this.createClient(args) },
      ...(options.clock ? { clock: options.clock } : {}),
    });
    this.set.onChange((event) => this.onSetChange(event));
  }

  // ---- the primary: the connection runtime.ts owns ----

  /** `runtime.ts` built a client for the active computer. */
  beginPrimary(client: KybernClient, profile: PrimaryProfile) {
    this.primary = { client, profile };
    this.lists = null;
  }

  /** The primary client opened: join the set under the daemon's machine id. */
  async primaryOpened(client: KybernClient): Promise<void> {
    const primary = this.primary;
    if (!primary || primary.client !== client || this.disposed) return;
    const info = client.info;
    const machineId = info?.machine_id || info?.environment_id;
    if (!machineId) return;
    // A reconnect of the same daemon: the set already follows the client's own status.
    if (primary.machineId === machineId && this.set.connection(machineId)?.status !== "paused") return;
    primary.machineId = machineId;
    this.adopted.add(machineId);
    await this.set.addMachine({
      machineId,
      name: primary.profile.name,
      // The set never dials this route: the forwarded client is the connection.
      routes: [{ kind: "direct_advertised", url: "http://127.0.0.1" }],
      member: false,
      paused: false,
      legacyProfileId: primary.profile.id,
    });
    if (this.primary?.client !== client) return;
    // The saved record of this computer had a stand-in id until the daemon answered.
    for (const other of this.set.connections()) {
      const record = other.record;
      if (record.legacyProfileId === primary.profile.id && record.machineId !== machineId && isLegacyMachineId(record.machineId)) {
        await this.set.removeMachine(record.machineId);
      }
    }
    this.set.setLocalMachine(machineId);
    this.watchOthers();
    this.scheduleFlush();
    this.connectOthers();
  }

  /** The primary client was closed (switching computers, a reconnect from scratch). */
  releasePrimary() {
    const primary = this.primary;
    if (!primary) return;
    this.primary = null;
    this.lists = null;
    this.cancelFlush();
    for (const wake of [...this.waiters]) wake();
    // Paused, so the set does not retry a socket that only the app can open.
    if (primary.machineId) void this.set.setPaused(primary.machineId, true);
  }

  /** The lists `runtime.ts` just read from the primary daemon (all threads, archived included). */
  ingestPrimary(client: KybernClient, projects: Project[], threads: Thread[]) {
    if (this.primary?.client !== client) return;
    this.lists = { owner: client, projects, threads, ingested: false };
    for (const wake of [...this.waiters]) wake();
    this.scheduleFlush();
  }

  /**
   * The saved computers changed (added, paired, removed). With merged lists on,
   * the set follows: new ones connect, removed ones are forgotten. With it off the
   * set is left alone, and the saved computers are read again at the next start.
   * The primary is never touched here: `releasePrimary` handles it.
   */
  async syncRecords(): Promise<void> {
    if (!this.options.mergedLists() || this.disposed) return;
    const wanted = this.options.records();
    const known = new Set(this.set.connections().map((c) => c.record.machineId));
    const ids = new Set(wanted.map((record) => record.machineId));
    for (const record of wanted) {
      if (!known.has(record.machineId) && !this.adoptedProfile(record.legacyProfileId)) await this.set.addMachine(record);
    }
    for (const connection of this.set.connections()) {
      const id = connection.record.machineId;
      // A machine the app added under another id than the daemon reported stays; only saved computers that vanished go.
      if (!ids.has(id) && connection.record.legacyProfileId && !this.adopted.has(id)) await this.set.removeMachine(id);
    }
  }

  // ---- reading ----

  /** The machine the user is at: where the active client points. */
  get localMachineId(): MachineId | undefined { return this.set.localMachineId; }
  get primaryClient(): KybernClient | null { return this.primary?.client ?? null; }
  /** The primary's machine id once its daemon has answered. */
  get primaryMachineId(): MachineId | undefined { return this.primary?.machineId; }

  /** The machines the set knows (saved computers included, connected or not). */
  get machineCount(): number { return this.set.connections().length; }

  /** The merged lists of every machine. Stable between changes. */
  view(): MergedView { return this.set.merged(); }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    this.scheduleFlush();
    return () => { this.listeners.delete(listener); };
  }

  connections(): readonly MachineConnection[] { return this.set.connections(); }

  /** A machine's client (throws `OfflineError` while it cannot be reached). */
  clientFor(machineId: MachineId): KybernClient { return this.set.clientFor(machineId); }

  /**
   * The client of the machine that owns a thread. Thread ids are unique per
   * machine only, so pass `machineId` when the caller has it; an unlisted thread
   * (a new chat) belongs to the machine the user is at.
   */
  clientForThread(threadId: string, machineId?: MachineId): KybernClient {
    return this.set.clientFor(machineId ?? this.set.machineOfThread(threadId) ?? this.requireLocal());
  }

  /** The client of the machine that owns a project instance; `machineId` picks one of several checkouts. */
  clientForProject(projectId: string, machineId?: MachineId): KybernClient {
    return this.set.clientFor(machineId ?? this.set.machineOfProject(projectId) ?? this.requireLocal());
  }

  machineOfThread(threadId: string, hint?: MachineId): MachineId | undefined {
    return this.set.machineOfThread(threadId, hint) ?? this.set.localMachineId;
  }

  dispose() {
    this.disposed = true;
    this.cancelFlush();
    for (const wake of [...this.waiters]) wake();
    this.set.dispose();
    this.listeners.clear();
  }

  // ---- internals ----

  private requireLocal(): MachineId {
    const id = this.set.localMachineId;
    if (!id) throw new UnknownMachineError("local");
    return id;
  }

  private adoptedProfile(profileId: string | undefined): boolean {
    return !!profileId && this.primary?.profile.id === profileId;
  }

  private credentials(): CredentialStore {
    const profileOf = (machineId: MachineId) => this.set.connection(machineId)?.record.legacyProfileId;
    return {
      get: async (machineId) => {
        if (this.adopted.has(machineId)) return PRIMARY_TOKEN;
        const profile = profileOf(machineId);
        if (!profile || !this.options.readCredential) return undefined;
        try { return await this.options.readCredential(profile); } catch { return undefined; }
      },
      // The saved computers stay the credential store until pairing writes per-machine tokens.
      set: () => {},
      delete: () => {},
    };
  }

  private createClient(args: Parameters<MachineTransport["createClient"]>[0]) {
    const { record, route, token } = args;
    const primary = this.primary;
    if (this.adopted.has(record.machineId)) {
      if (primary?.machineId !== record.machineId) throw new Error("Reconnecting");
      return new ForwardedClient(primary.client, this.listSource(primary));
    }
    if (this.options.transport?.createClient) return this.options.transport.createClient(args);
    const legacy = isLegacyMachineId(record.machineId);
    const base: ClientOptions = {
      ...(this.options.socket ? { createSocket: this.options.socket } : {}),
      ...(legacy ? {} : { expectedEnvironmentId: record.machineId }),
    };
    return new KybernClient(
      { url: normalizeDaemonUrl(route.url), token, ...(legacy ? {} : { environmentId: record.machineId }) },
      base,
    );
  }

  private listSource(primary: Primary): ListSource {
    return {
      read: (signal) => new Promise((resolve, reject) => {
        const settle = () => {
          if (signal.aborted || this.primary !== primary) { cleanup(); reject(new Error("Closed")); return true; }
          if (this.lists?.owner === primary.client) { cleanup(); resolve(this.lists); return true; }
          return false;
        };
        const cleanup = () => { this.waiters.delete(settle); signal.removeEventListener("abort", settle); };
        if (settle()) return;
        this.waiters.add(settle);
        signal.addEventListener("abort", settle);
      }),
    };
  }

  private onSetChange(event: MachineSetEvent) {
    if (event.type === "records" || event.type === "status") {
      this.watchOthers();
      this.scheduleFlush();
    }
    for (const listener of [...this.listeners]) listener();
  }

  /** Merged lists on: the set connects every other saved machine and reads its lists. Once per set of records. */
  private connectOthers() {
    if (!this.options.mergedLists() || this.connecting || this.disposed) return;
    this.connecting = this.set.ensureAll().catch(() => {}).finally(() => { this.connecting = undefined; });
  }

  /** Lists changed on a machine the set connects itself: read that machine again (runtime.ts does it for the primary). */
  private watchOthers() {
    for (const connection of this.set.connections()) {
      const id = connection.record.machineId;
      if (this.watched.has(id) || this.adopted.has(id) || (connection.record.legacyProfileId && isLegacyMachineId(id))) continue;
      this.watched.add(id);
      const handle = this.set.handleFor(id);
      const refresh = () => void this.refreshMachine(id);
      handle.onNotification("projects.changed", refresh);
      handle.onNotification("threads.changed", refresh);
    }
  }

  /** One read per machine at a time; a change that arrives during a read folds into one rerun. */
  private async refreshMachine(id: MachineId): Promise<void> {
    if (this.refreshes.has(id)) { this.refreshes.set(id, true); return; }
    this.refreshes.set(id, false);
    try {
      do {
        this.refreshes.set(id, false);
        await this.set.refresh(id);
      } while (this.refreshes.get(id) && !this.disposed);
    } finally {
      this.refreshes.delete(id);
    }
  }

  // The set caches and merges whatever it is given. With merged lists off, or one
  // machine and nothing watching the merged view, that work has no reader, so the
  // primary's lists wait (by reference) until a second machine is live or a view subscribes.
  private wanted(): boolean {
    if (!this.options.mergedLists()) return false;
    if (this.listeners.size > 0) return true;
    let live = 0;
    for (const connection of this.set.connections()) if (LIVE.has(connection.status)) live++;
    return live > 1;
  }

  private cancelFlush() {
    if (this.flushTimer === undefined) return;
    if (this.options.clearTimer) this.options.clearTimer(this.flushTimer);
    else clearTimeout(this.flushTimer as ReturnType<typeof setTimeout>);
    this.flushTimer = undefined;
  }

  private scheduleFlush() {
    if (this.flushTimer !== undefined || this.disposed || !this.lists || this.lists.ingested || !this.primary?.machineId || !this.wanted()) return;
    const setTimer = this.options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    this.flushTimer = setTimer(() => {
      this.flushTimer = undefined;
      const lists = this.lists, primary = this.primary;
      if (!lists || lists.ingested || !primary?.machineId || primary.client !== lists.owner) return;
      lists.ingested = true;
      this.set.ingest(primary.machineId, { projects: lists.projects, threads: lists.threads });
    }, this.options.ingestDelayMs ?? 300);
  }
}
