// One connection per machine, merged by the app (design §3.4 and §5.1). The
// machine set owns each machine's lifecycle: ordered routes with failover,
// identity checks before any credential is sent, relay routes through a
// member, lazily minted per-machine tokens, and each machine's last lists for
// when it is offline. It is framework-agnostic: sockets, HTTP, storage, clocks
// and Ed25519 are all injected, so GPUIX, React Native and the tests share it.
import { normalizeDaemonUrl } from "./address.ts";
import { KybernClient, type ClientOptions } from "./client.ts";
import { MachineCache } from "./machineCache.ts";
import { MachineClientProxy, OfflineError, type MachineClient } from "./machineClient.ts";
import {
  machineGlyph,
  mergeProjects,
  mergeThreads,
  showMachineGlyph,
  type LogicalProject,
  type MachineGlyph,
  type MachineThread,
  type MergedThreads,
} from "./machineMerge.ts";
import {
  IDENTITY_MISMATCH_MESSAGE,
  MAX_ROUTES_PER_MACHINE,
  checkWellKnown,
  orderRoutes,
  probeTimeoutMs,
  relayRoute,
  routeHost,
  routeId,
  routeRefusal,
  wellKnownUrl,
  type ProofInput,
  type WellKnownAnswer,
} from "./machineRoutes.ts";
import {
  NETWORK_FEATURES,
  type DaemonInfo,
  type MachineCard,
  type MachineId,
  type NetworkClientGrantResult,
  type Project,
  type Route,
  type Thread,
} from "./types.ts";

export { OfflineError } from "./machineClient.ts";
export type { MachineClient } from "./machineClient.ts";

// ---- records, stores, transport ----

/** What a client remembers about one machine. Persisted by the app. */
export interface MachineRecord {
  machineId: MachineId;
  name: string;
  os?: string;
  /** Configured routes, such as a saved SSH tunnel or an advertised URL. */
  routes: Route[];
  /** The machine's Ed25519 key, pinned from the first verified well-known answer or given by the network. */
  signingKey?: string;
  /** In the user's network. A saved daemon older than the network is not a member. */
  member: boolean;
  paused?: boolean;
  legacyProfileId?: string;
  /** Routes the network reported; replaced whole each time it reports. */
  learned?: Route[];
  /** Route ids that answered as another machine. They are never tried again until cleared. */
  blockedRoutes?: string[];
}

type MaybePromise<T> = T | Promise<T>;

export interface MachineStore {
  load(): MaybePromise<MachineRecord[]>;
  save(records: MachineRecord[]): MaybePromise<void>;
}

/** Device tokens, one per machine, in the platform's secure store. */
export interface CredentialStore {
  get(machineId: MachineId): MaybePromise<string | null | undefined>;
  set(machineId: MachineId, token: string): MaybePromise<void>;
  delete(machineId: MachineId): MaybePromise<void>;
}

export type SocketFactory = (url: string, token: string) => WebSocket;

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The effects a machine set needs. Every one has a default except the proof check. */
export interface MachineTransport {
  /** `GET` the identity document at `url`, with no credential. Throws when nothing answers in time. */
  probe(url: string, options: { timeoutMs: number }): Promise<unknown>;
  /** A client that, once `connect()`ed, talks to `route` with `token`. Called only after the route verified. */
  createClient(args: { record: MachineRecord; route: Route; token: string }): MachineClient;
  /** 32 random bytes, base64url. */
  nonce(): string;
}

/** `fetch` for the identity document: no redirects, a hard timeout. */
export async function fetchProbe(url: string, options: { timeoutMs: number }): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetch(url, { redirect: "error", signal: controller.signal, headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`The machine answered ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
export function randomNonce(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (let at = 0; at < bytes.length; at += 3) {
    const n = (bytes[at]! << 16) | ((bytes[at + 1] ?? 0) << 8) | (bytes[at + 2] ?? 0);
    out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]! + B64URL[(n >> 6) & 63]! + B64URL[n & 63]!;
  }
  return out.slice(0, 43);
}

/** The default `createClient`: a `KybernClient` on the route, checking the machine id again on open. */
export function kybernClientFactory(createSocket?: SocketFactory, base: ClientOptions = {}): MachineTransport["createClient"] {
  return ({ record, route, token }) =>
    new KybernClient(
      { url: normalizeDaemonUrl(route.url), token, environmentId: record.machineId },
      { ...base, expectedEnvironmentId: record.machineId, ...(createSocket ? { createSocket } : {}) },
    );
}

// ---- connection view ----

export type MachineConnectionStatus = "online" | "relaying" | "offline" | "paused" | "needs-update" | "unpaired";

export type MachineErrorCode =
  /** An address answered as a different machine. The route is blocked until the user clears it. */
  | "identity_mismatch"
  /** `pinPolicy: "require"` and this machine's key was never pinned. Nothing was sent. */
  | "unpinned"
  /** The identity proof was too old or too new: check the clock. */
  | "clock"
  | "unreachable"
  | "insecure_route"
  | "no_route"
  /** No token for this machine and no member could mint one. */
  | "unpaired"
  | "refresh_failed";

export interface MachineError {
  code: MachineErrorCode;
  message: string;
  route?: Route;
}

export interface MachineConnection {
  record: MachineRecord;
  /** One per machine, for the life of the set; its route changes underneath. Calls reject with `OfflineError` while offline. */
  client: KybernClient;
  status: MachineConnectionStatus;
  info?: DaemonInfo;
  features: Set<string>;
  /** The route in use, while connected. */
  route?: Route;
  /** The member a `relaying` machine goes through. */
  relayVia?: MachineId;
  error?: MachineError;
  /** A connection attempt is running. */
  connecting: boolean;
  latencyMs?: number;
  /** When this machine last answered, in ms. Shown as "Offline · last seen 2 h ago". */
  lastSeenAt?: number;
  /** Cached lists are available for this machine. */
  hasCache: boolean;
}

export type MachineSetEvent = {
  type: "status" | "lists" | "records" | "routes";
  machineId?: MachineId;
};

export class UnknownMachineError extends Error {
  readonly machineId: string;
  constructor(machineId: string) {
    super("This machine is not in your list");
    this.name = "UnknownMachineError";
    this.machineId = machineId;
  }
}

/** The merged lists one `merged()` call returns. Entries that did not change keep their identity. */
export interface MergedView {
  version: number;
  machines: MachineSummary[];
  projects: LogicalProject[];
  threads: MergedThreads;
  /** More than one machine is known: show the machine glyph on threads. */
  showGlyphs: boolean;
}

export interface MachineSummary {
  machineId: MachineId;
  name: string;
  status: MachineConnectionStatus;
  /** The machine's lists are cached copies. */
  offline: boolean;
  lastSeenAt?: number;
  isLocal: boolean;
  glyph: MachineGlyph;
  /** Show the glyph on this machine's threads. */
  showGlyph: boolean;
}

export interface MachineSetOptions {
  store: MachineStore;
  credentials: CredentialStore;
  /** This device's id, sent to `network.client_grant`. Stable across launches. */
  deviceId: string;
  /** Checks an Ed25519 signature. Required: the identity check is the whole point of the pinned key. */
  verifyProof: (input: ProofInput) => MaybePromise<boolean>;
  /** The machine the user is at: the desktop's own daemon, or the member a phone paired with. */
  localMachineId?: MachineId;
  cache?: MachineCache;
  /** Used by the default `createClient`. Native platforms authenticate the upgrade with a header here. */
  socket?: SocketFactory;
  transport?: Partial<MachineTransport>;
  clock?: Clock;
  /** Accept the first key a machine proves as its own when none was given (default). `"require"` refuses to connect to a machine whose key is not pinned. */
  pinPolicy?: "first-use" | "require";
  /** How long a connection may sit reconnecting before the set tries the other routes (default 8 s). */
  reconnectGraceMs?: number;
  /** How long one route may take to open (default 15 s). */
  connectTimeoutMs?: number;
  /** Better routes are probed this often (default 5 min). */
  probeIntervalMs?: number;
  /** Newest threads kept in memory per machine (default 2000). */
  maxThreadsPerMachine?: number;
  /** Machines kept (default 32). */
  maxMachines?: number;
}

const MAX_PROJECTS_PER_MACHINE = 1000;
const FAILURE_DELAYS_MS = [2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 300_000];
const LIVE: ReadonlySet<MachineConnectionStatus> = new Set(["online", "relaying", "needs-update"]);

interface Opened {
  inner: MachineClient;
  route: Route;
  latencyMs?: number;
}

interface Slot {
  record: MachineRecord;
  proxy: MachineClientProxy;
  inner?: MachineClient;
  offInner?: () => void;
  route?: Route;
  status: MachineConnectionStatus;
  error?: MachineError;
  latencyMs?: number;
  lastSeenAt?: number;
  /** Bumped to cancel whatever is in flight for this slot. */
  gen: number;
  attempt?: Promise<void>;
  probing?: boolean;
  refreshing?: Promise<void>;
  /** Ids of the routes the last attempt looked at. */
  tried?: Set<string>;
  failures: number;
  retryTimer?: unknown;
  graceTimer?: unknown;
  lists?: { projects: Project[]; threads: MachineThread[] };
  view?: MachineConnection;
}

function errorMessage(code: MachineErrorCode, machine: string): string {
  switch (code) {
    case "identity_mismatch":
      return IDENTITY_MISMATCH_MESSAGE;
    case "unpinned":
      return `${machine} has not been verified yet. Add it again from a machine that is in your network`;
    case "clock":
      return `${machine} answered with a time that is off. Check the date and time on both`;
    case "insecure_route":
      return `Public addresses must use HTTPS. Add a secure address for ${machine}`;
    case "no_route":
      return `No address for ${machine} yet`;
    case "unpaired":
      return `Pair this device with ${machine}`;
    case "refresh_failed":
      return `Could not read ${machine}'s lists`;
    default:
      return `${machine} is not answering`;
  }
}

const ERROR_RANK: Record<MachineErrorCode, number> = {
  identity_mismatch: 7,
  unpinned: 6,
  clock: 5,
  insecure_route: 4,
  unreachable: 3,
  no_route: 2,
  unpaired: 1,
  refresh_failed: 0,
};

async function mapLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export class MachineSet {
  private readonly options: MachineSetOptions;
  private readonly transport: MachineTransport;
  private readonly clock: Clock;
  private readonly cache: MachineCache;
  private readonly slots = new Map<MachineId, Slot>();
  private readonly listeners = new Set<(event: MachineSetEvent) => void>();
  private localId: MachineId | undefined;
  private loaded: Promise<void> | undefined;
  private saving: Promise<void> = Promise.resolve();
  private saveQueued = false;
  private probeTimer: unknown;
  private syncTimer: unknown;
  private syncing: Promise<void> | undefined;
  private disposed = false;
  private _version = 0;
  private mergedView: MergedView | undefined;
  private owners: { version: number; threads: Map<string, MachineId[]>; projects: Map<string, MachineId[]> } | undefined;

  constructor(options: MachineSetOptions) {
    this.options = options;
    this.clock = options.clock ?? systemClock;
    this.cache = options.cache ?? new MachineCache();
    this.localId = options.localMachineId;
    this.transport = {
      probe: options.transport?.probe ?? fetchProbe,
      createClient: options.transport?.createClient ?? kybernClientFactory(options.socket),
      nonce: options.transport?.nonce ?? randomNonce,
    };
  }

  // ---- reading ----

  get version(): number {
    return this._version;
  }

  /** The machine the user is at. */
  get localMachineId(): MachineId | undefined {
    return this.localId;
  }

  setLocalMachine(machineId: MachineId | undefined): void {
    if (this.localId === machineId) return;
    this.localId = machineId;
    this.touch(undefined, "records");
  }

  /** Every machine, the local one first, then in the order they were added. */
  connections(): readonly MachineConnection[] {
    return this.orderedSlots().map((slot) => this.viewOf(slot));
  }

  connection(machineId: MachineId): MachineConnection | undefined {
    const slot = this.slots.get(machineId);
    return slot && this.viewOf(slot);
  }

  /** The machine's client. Throws `OfflineError` (with `cached`) when it cannot be reached now. */
  clientFor(machineId: MachineId): KybernClient {
    const slot = this.slots.get(machineId);
    if (!slot) throw new UnknownMachineError(machineId);
    if (!slot.inner || !LIVE.has(slot.status)) throw new OfflineError(machineId, this.hasCache(slot));
    return slot.proxy;
  }

  /**
   * The machine's client even while it is offline. Subscriptions and handlers
   * made on it are kept and attached when the machine connects; calls reject
   * with `OfflineError` until then.
   */
  handleFor(machineId: MachineId): KybernClient {
    const slot = this.slots.get(machineId);
    if (!slot) throw new UnknownMachineError(machineId);
    return slot.proxy;
  }

  /**
   * The machine that owns a thread. Thread ids are unique per machine, not
   * across machines: when two machines list the same id, `hint` decides, then
   * the local machine, then the first machine in order. Use `scopedKey` to
   * avoid the question.
   */
  machineOfThread(id: string, hint?: MachineId): MachineId | undefined {
    return this.pick(this.ownerIndex().threads.get(id), hint);
  }

  machineOfProject(id: string, hint?: MachineId): MachineId | undefined {
    return this.pick(this.ownerIndex().projects.get(id), hint);
  }

  /** Every machine that lists this thread id. */
  machinesOfThread(id: string): MachineId[] {
    return [...(this.ownerIndex().threads.get(id) ?? [])];
  }

  onChange(fn: (event: MachineSetEvent) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  // ---- lifecycle ----

  /** Load saved machines and lists, connect to every machine, learn the rest of the network from any member, and read each machine's lists. */
  async ensureAll(): Promise<void> {
    await this.load();
    if (this.disposed) return;
    await this.connectAll();
    await this.syncMembers();
    // A machine that had no token may be mintable now that a member is up.
    await mapLimit(
      [...this.slots.values()].filter((slot) => slot.status === "unpaired" && !slot.record.paused),
      4,
      (slot) => this.connectSlot(slot),
    );
    await this.refresh();
    this.scheduleProbe();
  }

  /** Add a machine the user just paired with, keeping its token, and connect to it. */
  async addMachine(
    input: Pick<MachineRecord, "machineId" | "name"> & Partial<Omit<MachineRecord, "machineId" | "name">>,
    token?: string,
  ): Promise<MachineConnection> {
    await this.load();
    const existing = this.slots.get(input.machineId);
    if (token) await this.options.credentials.set(input.machineId, token);
    if (existing) {
      Object.assign(existing.record, input, { routes: input.routes ?? existing.record.routes });
      this.persist();
      this.touch(existing, "records");
      await this.connectSlot(existing);
      return this.viewOf(existing);
    }
    if (this.slots.size >= (this.options.maxMachines ?? 32)) throw new Error("Remove a machine before adding another");
    const slot = this.createSlot({ routes: [], member: true, ...input });
    this.persist();
    this.touch(slot, "records");
    await this.connectSlot(slot);
    return this.viewOf(slot);
  }

  /** Forget a machine: close it and delete its token, cached lists and record. */
  async removeMachine(machineId: MachineId): Promise<void> {
    const slot = this.slots.get(machineId);
    if (!slot) return;
    this.dropSlot(slot);
    this.slots.delete(machineId);
    this.cache.delete(machineId);
    try {
      await this.options.credentials.delete(machineId);
    } catch {
      // The record is gone; a leftover token is never used without one.
    }
    this.persist();
    this.touch(undefined, "records");
  }

  /** Pause: keep the machine listed from its cache and stop talking to it. */
  async setPaused(machineId: MachineId, paused: boolean): Promise<void> {
    const slot = this.slots.get(machineId);
    if (!slot || !!slot.record.paused === paused) return;
    slot.record.paused = paused;
    this.persist();
    if (paused) this.goOffline(slot, "paused");
    else await this.connectSlot(slot);
    this.touch(slot, "records");
  }

  /** The user chose to trust a blocked address again (or one machine's blocks entirely). */
  async clearBlockedRoutes(machineId: MachineId, route?: Route): Promise<void> {
    const slot = this.slots.get(machineId);
    if (!slot) return;
    slot.record.blockedRoutes = route ? (slot.record.blockedRoutes ?? []).filter((id) => id !== routeId(route)) : [];
    this.persist();
    await this.connectSlot(slot);
  }

  /** The OS reported a network change: retry offline machines now and look for better routes. */
  async networkChanged(): Promise<void> {
    for (const slot of this.slots.values()) {
      slot.failures = 0;
      this.clock.clearTimeout(slot.retryTimer);
    }
    await Promise.all(
      [...this.slots.values()].map((slot) => (LIVE.has(slot.status) ? this.probeBetter(slot) : this.connectSlot(slot))),
    );
  }

  /** Close every connection and stop every timer. The set cannot be used afterwards. */
  dispose(): void {
    this.disposed = true;
    this.clock.clearTimeout(this.probeTimer);
    this.clock.clearTimeout(this.syncTimer);
    for (const slot of this.slots.values()) this.dropSlot(slot);
    this.listeners.clear();
  }

  // ---- lists ----

  /** Replace what is known of a machine's lists with a read the app made itself, and cache it. */
  ingest(machineId: MachineId, lists: { projects?: readonly Project[]; threads?: readonly Thread[] }): void {
    const slot = this.slots.get(machineId);
    if (!slot) return;
    // Bounded in memory: the newest threads only, however many a machine has.
    const max = this.options.maxThreadsPerMachine ?? 2000;
    const projects = lists.projects ? lists.projects.slice(0, MAX_PROJECTS_PER_MACHINE) : (slot.lists?.projects ?? []);
    const threads = lists.threads
      ? lists.threads.length > max
        ? [...lists.threads].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)).slice(0, max)
        : [...lists.threads]
      : (slot.lists?.threads ?? []);
    slot.lists = { projects, threads };
    if (LIVE.has(slot.status)) this.cache.put(machineId, { projects, threads }, this.clock.now());
    this.touch(slot, "lists");
  }

  /** Read projects and threads from every machine that is online (or one machine) and replace its lists and cached copy. */
  async refresh(machineId?: MachineId): Promise<void> {
    const targets = [...this.slots.values()].filter(
      (slot) => (!machineId || slot.record.machineId === machineId) && slot.inner && LIVE.has(slot.status),
    );
    await mapLimit(targets, 4, (slot) => this.refreshSlot(slot));
  }

  /** One read per machine at a time; a second caller waits for the first. */
  private refreshSlot(slot: Slot): Promise<void> {
    if (slot.refreshing) return slot.refreshing;
    const inner = slot.inner;
    if (!inner) return Promise.resolve();
    const run = (async () => {
      try {
        const [projects, threads] = await Promise.all([inner.call("projects.list", {}), inner.call("threads.list", {})]);
        if (slot.inner !== inner) return;
        this.ingest(slot.record.machineId, { projects: projects.projects, threads: threads.threads });
      } catch {
        if (slot.inner === inner && !slot.error) {
          slot.error = { code: "refresh_failed", message: errorMessage("refresh_failed", slot.record.name) };
          this.touch(slot, "status");
        }
      }
    })().finally(() => {
      if (slot.refreshing === run) slot.refreshing = undefined;
    });
    slot.refreshing = run;
    return run;
  }

  /** The merged projects and threads of every machine. Cached until something changes. */
  merged(): MergedView {
    if (this.mergedView?.version === this._version) return this.mergedView;
    const slots = this.orderedSlots();
    const offline = new Set<MachineId>();
    const lastSeenAt = new Map<MachineId, number>();
    const projects = new Map<MachineId, readonly Project[]>();
    const threads = new Map<MachineId, readonly MachineThread[]>();
    for (const slot of slots) {
      const id = slot.record.machineId;
      if (!LIVE.has(slot.status)) {
        offline.add(id);
        const seen = slot.lastSeenAt ?? this.cache.get(id)?.savedAt;
        if (seen !== undefined) lastSeenAt.set(id, seen);
      }
      if (slot.lists) {
        projects.set(id, slot.lists.projects);
        threads.set(id, slot.lists.threads);
      }
    }
    const machineOrder = slots.map((slot) => slot.record.machineId);
    const logical = mergeProjects(projects, {
      localMachineId: this.localId,
      machineOrder,
      offline,
      previous: this.mergedView?.projects,
    });
    const merged = mergeThreads(threads, logical, {
      offline,
      lastSeenAt,
      previous: this.mergedView?.threads,
      maxPerMachine: this.options.maxThreadsPerMachine ?? 2000,
    });
    const count = slots.length;
    this.mergedView = {
      version: this._version,
      projects: logical,
      threads: merged,
      showGlyphs: count > 1,
      machines: slots.map((slot) => {
        const machineId = slot.record.machineId;
        return {
          machineId,
          name: slot.record.name,
          status: slot.status,
          offline: offline.has(machineId),
          lastSeenAt: lastSeenAt.get(machineId),
          isLocal: machineId === this.localId,
          glyph: machineGlyph({ machineId, name: slot.record.name }),
          showGlyph: showMachineGlyph({ machineCount: count, machineId, localMachineId: this.localId }),
        };
      }),
    };
    return this.mergedView;
  }

  // ---- loading and persistence ----

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      let records: MachineRecord[] = [];
      try {
        records = (await this.options.store.load()) ?? [];
      } catch {
        records = [];
      }
      for (const record of records.slice(0, this.options.maxMachines ?? 32)) {
        if (!record?.machineId || this.slots.has(record.machineId)) continue;
        this.createSlot({ ...record, routes: [...(record.routes ?? [])] });
      }
      await this.cache.load();
      for (const slot of this.slots.values()) {
        const snapshot = this.cache.get(slot.record.machineId);
        if (snapshot && !slot.lists) {
          slot.lists = { projects: snapshot.projects, threads: snapshot.threads };
          slot.lastSeenAt ??= snapshot.savedAt;
        }
      }
      this.touch(undefined, "records");
    })();
    return this.loaded;
  }

  private persist() {
    if (this.saveQueued) return;
    this.saveQueued = true;
    this.saving = this.saving.then(async () => {
      this.saveQueued = false;
      try {
        await this.options.store.save([...this.slots.values()].map((slot) => slot.record));
      } catch {
        // The next change saves again.
      }
    });
  }

  /** Resolves when everything changed so far is saved. */
  async flush(): Promise<void> {
    await this.saving;
    await this.cache.flush();
  }

  private createSlot(record: MachineRecord): Slot {
    const slot: Slot = {
      record,
      proxy: new MachineClientProxy(record.machineId, () => this.hasCache(slot)),
      status: record.paused ? "paused" : "offline",
      gen: 0,
      failures: 0,
    };
    // Members tell clients when the network changes. The proxy keeps these handlers across route changes.
    slot.proxy.onNotification("network.changed", () => this.scheduleSync());
    slot.proxy.onNotification("network.machine.changed", () => this.scheduleSync());
    this.slots.set(record.machineId, slot);
    return slot;
  }

  private dropSlot(slot: Slot) {
    slot.gen++;
    this.clock.clearTimeout(slot.retryTimer);
    this.clock.clearTimeout(slot.graceTimer);
    slot.offInner?.();
    slot.offInner = undefined;
    slot.proxy.attach(undefined);
    slot.inner?.close("Machine removed");
    slot.inner = undefined;
  }

  private hasCache(slot: Slot): boolean {
    return !!slot.lists || !!this.cache.get(slot.record.machineId);
  }

  private orderedSlots(): Slot[] {
    const all = [...this.slots.values()];
    const local = all.find((slot) => slot.record.machineId === this.localId);
    return local ? [local, ...all.filter((slot) => slot !== local)] : all;
  }

  private pick(owners: readonly MachineId[] | undefined, hint: MachineId | undefined): MachineId | undefined {
    if (!owners?.length) return undefined;
    if (hint && owners.includes(hint)) return hint;
    if (this.localId && owners.includes(this.localId)) return this.localId;
    return owners[0];
  }

  private ownerIndex() {
    if (this.owners?.version === this._version) return this.owners;
    const threads = new Map<string, MachineId[]>();
    const projects = new Map<string, MachineId[]>();
    const add = (index: Map<string, MachineId[]>, id: string, machineId: MachineId) => {
      const list = index.get(id);
      if (!list) index.set(id, [machineId]);
      else if (!list.includes(machineId)) list.push(machineId);
    };
    for (const slot of this.orderedSlots()) {
      for (const thread of slot.lists?.threads ?? []) add(threads, thread.id, slot.record.machineId);
      for (const project of slot.lists?.projects ?? []) add(projects, project.id, slot.record.machineId);
    }
    this.owners = { version: this._version, threads, projects };
    return this.owners;
  }

  private touch(slot: Slot | undefined, type: MachineSetEvent["type"]) {
    if (slot) slot.view = undefined;
    this._version++;
    const event: MachineSetEvent = slot ? { type, machineId: slot.record.machineId } : { type };
    for (const fn of [...this.listeners]) fn(event);
  }

  private viewOf(slot: Slot): MachineConnection {
    if (slot.view) return slot.view;
    const info = slot.inner?.info ?? undefined;
    const view: MachineConnection = {
      record: slot.record,
      client: slot.proxy,
      status: slot.status,
      features: new Set(info?.features ?? []),
      connecting: slot.attempt !== undefined,
      hasCache: this.hasCache(slot),
    };
    if (info) view.info = info;
    if (slot.route && LIVE.has(slot.status)) {
      view.route = slot.route;
      if (slot.route.kind === "relay" && slot.route.via) view.relayVia = slot.route.via;
    }
    if (slot.error) view.error = slot.error;
    if (slot.latencyMs !== undefined) view.latencyMs = slot.latencyMs;
    if (slot.lastSeenAt !== undefined) view.lastSeenAt = slot.lastSeenAt;
    slot.view = view;
    return view;
  }

  // ---- connecting ----

  private async connectAll(): Promise<void> {
    const todo = [...this.slots.values()].filter((slot) => !slot.record.paused && !LIVE.has(slot.status));
    await mapLimit(todo, 4, (slot) => this.connectSlot(slot));
    // A machine only reachable through a member waits for that member to be up.
    // Only machines that now have a relay route they have not tried; the direct routes that failed are not probed again.
    const waiting = todo.filter(
      (slot) =>
        slot.record.member &&
        slot.status === "offline" &&
        this.candidates(slot).some((route) => !slot.tried?.has(routeId(route))),
    );
    if (waiting.length) await mapLimit(waiting, 4, (slot) => this.connectSlot(slot));
  }

  /** Find a route that verifies and opens, and move the machine onto it. Concurrent calls share one attempt. */
  private connectSlot(slot: Slot): Promise<void> {
    if (slot.record.paused) {
      this.goOffline(slot, "paused");
      return Promise.resolve();
    }
    if (slot.attempt) return slot.attempt;
    this.clock.clearTimeout(slot.retryTimer);
    const gen = ++slot.gen;
    const attempt = (async () => {
      try {
        const result = await this.findRoute(slot, gen, {});
        if (gen !== slot.gen || this.disposed) {
          if (result.kind === "open") result.opened.inner.close("Superseded");
          return;
        }
        if (result.kind === "open") this.adopt(slot, result.opened);
        else this.goOffline(slot, result.kind === "unpaired" ? "unpaired" : "offline", result.error);
      } catch {
        if (gen === slot.gen) this.goOffline(slot, "offline");
      }
    })().finally(() => {
      if (slot.attempt === attempt) slot.attempt = undefined;
      if (gen === slot.gen) this.touch(slot, "status");
    });
    slot.attempt = attempt;
    this.touch(slot, "status");
    return attempt;
  }

  /** Candidate routes in the order they are tried: tailnet, advertised, SSH, then relays through connected members. */
  private candidates(slot: Slot): Route[] {
    const { record } = slot;
    const own = orderRoutes(record.routes, record.learned);
    if (!record.member) return own;
    const relays: Route[] = [];
    const members = [...this.slots.values()]
      .filter(
        (other) =>
          other !== slot &&
          other.record.member &&
          other.route &&
          other.route.kind !== "relay" &&
          (other.status === "online" || other.status === "needs-update") &&
          other.inner?.info?.features?.includes(NETWORK_FEATURES.relay) !== false,
      )
      .sort((a, b) => (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity));
    for (const member of members) relays.push(relayRoute(member.route!.url, member.record.machineId, record.machineId));
    return orderRoutes(own, relays);
  }

  private async findRoute(
    slot: Slot,
    gen: number,
    scope: { before?: string },
  ): Promise<{ kind: "open"; opened: Opened } | { kind: "unpaired" | "none"; error?: MachineError }> {
    const { record } = slot;
    let token = await this.token(slot);
    if (gen !== slot.gen) return { kind: "none" };
    if (!token)
      return { kind: "unpaired", error: { code: "unpaired", message: errorMessage("unpaired", record.name) } };
    let routes = this.candidates(slot);
    if (scope.before === undefined) slot.tried = new Set(routes.map(routeId));
    if (scope.before !== undefined) {
      const at = routes.findIndex((route) => routeId(route) === scope.before);
      routes = at < 0 ? [] : routes.slice(0, at);
    }
    let worst: MachineError | undefined;
    const note = (code: MachineErrorCode, route?: Route) => {
      if (!worst || ERROR_RANK[code] > ERROR_RANK[worst.code])
        worst = { code, message: errorMessage(code, record.name), ...(route ? { route } : {}) };
    };
    if (!routes.length) note("no_route");
    for (const route of routes) {
      if (gen !== slot.gen || this.disposed) return { kind: "none" };
      if (record.blockedRoutes?.includes(routeId(route))) {
        note("identity_mismatch", route);
        continue;
      }
      if (routeRefusal(route)) {
        note("insecure_route", route);
        continue;
      }
      const identity = await this.verifyRoute(slot, route);
      if (gen !== slot.gen) return { kind: "none" };
      if (!identity.ok) {
        note(identity.code, route);
        continue;
      }
      let retried = false;
      for (;;) {
        const outcome = await this.open(slot, route, token, identity.latencyMs);
        if (gen !== slot.gen) {
          if (outcome.kind === "open") outcome.opened.inner.close("Superseded");
          return { kind: "none" };
        }
        if (outcome.kind === "open") return outcome;
        if (outcome.kind === "revoked" && !retried) {
          // The machine no longer accepts this device's token: mint a fresh one through a member, once.
          retried = true;
          await this.options.credentials.delete(record.machineId);
          token = await this.token(slot);
          if (!token) return { kind: "unpaired", error: { code: "unpaired", message: errorMessage("unpaired", record.name) } };
          continue;
        }
        note("unreachable", route);
        break;
      }
    }
    return { kind: "none", ...(worst ? { error: worst } : {}) };
  }

  /**
   * The identity check of design §3.2. Nothing carrying a credential is sent to
   * an address before this passes. A machine that is not a member (a daemon
   * older than the network) has no identity document; it is left to the client's
   * own environment id check.
   */
  private async verifyRoute(
    slot: Slot,
    route: Route,
  ): Promise<{ ok: true; latencyMs?: number } | { ok: false; code: MachineErrorCode }> {
    const { record } = slot;
    if (!record.member) return { ok: true };
    if (this.options.pinPolicy === "require" && !record.signingKey) return { ok: false, code: "unpinned" };
    const nonce = this.transport.nonce();
    const started = this.clock.now();
    let answer: unknown;
    try {
      answer = await this.transport.probe(wellKnownUrl(route, nonce), { timeoutMs: probeTimeoutMs(route) });
    } catch {
      return { ok: false, code: "unreachable" };
    }
    const latencyMs = this.clock.now() - started;
    const check = await checkWellKnown(answer as WellKnownAnswer, {
      nonce,
      host: routeHost(route),
      now: this.clock.now(),
      expected: { machineId: record.machineId, ...(record.signingKey ? { signingKey: record.signingKey } : {}) },
      verifyProof: this.options.verifyProof,
    });
    if (check.ok) {
      if (!record.signingKey) {
        record.signingKey = check.signingKey;
        this.persist();
      }
      return { ok: true, latencyMs };
    }
    if (check.fatal) {
      // Never retried silently: block this address until the user clears it.
      const id = routeId(route);
      if (!record.blockedRoutes?.includes(id)) {
        record.blockedRoutes = [...(record.blockedRoutes ?? []), id].slice(-MAX_ROUTES_PER_MACHINE);
        this.persist();
      }
      return { ok: false, code: "identity_mismatch" };
    }
    return { ok: false, code: "clock" };
  }

  private async open(
    slot: Slot,
    route: Route,
    token: string,
    latencyMs: number | undefined,
  ): Promise<{ kind: "open"; opened: Opened } | { kind: "revoked" | "failed" }> {
    let inner: MachineClient;
    try {
      inner = this.transport.createClient({ record: slot.record, route, token });
    } catch {
      return { kind: "failed" };
    }
    const outcome = await new Promise<"open" | "revoked" | "failed">((resolve) => {
      let settled = false;
      let timer: unknown;
      const done = (value: "open" | "revoked" | "failed") => {
        if (settled) return;
        settled = true;
        this.clock.clearTimeout(timer);
        off();
        resolve(value);
      };
      const off = inner.onStatus((status, detail) => {
        if (status === "open") done("open");
        else if (status === "failed" || status === "closed") done(/revoked|invalid|pair/i.test(detail ?? "") ? "revoked" : "failed");
      });
      timer = this.clock.setTimeout(() => done("failed"), this.options.connectTimeoutMs ?? 15_000);
      inner.connect();
      if (inner.status === "open") done("open");
    });
    if (outcome !== "open") {
      inner.close("Route did not open");
      return { kind: outcome };
    }
    return { kind: "open", opened: { inner, route, ...(latencyMs !== undefined ? { latencyMs } : {}) } };
  }

  /** Make `opened` the machine's connection. The one it replaces is closed after subscriptions have moved. */
  private adopt(slot: Slot, opened: Opened) {
    const previous = slot.inner;
    const wasLive = LIVE.has(slot.status);
    slot.offInner?.();
    this.clock.clearTimeout(slot.graceTimer);
    this.clock.clearTimeout(slot.retryTimer);
    slot.inner = opened.inner;
    slot.route = opened.route;
    slot.latencyMs = opened.latencyMs ?? slot.latencyMs;
    slot.error = undefined;
    slot.failures = 0;
    slot.lastSeenAt = this.clock.now();
    slot.status = this.liveStatus(slot);
    slot.offInner = opened.inner.onStatus((status) => this.onInnerStatus(slot, opened.inner, status));
    slot.proxy.attach(opened.inner);
    previous?.close("Moved to another route");
    this.touch(slot, "status");
    // What the cache holds for this machine is replaced with a fresh read.
    if (!wasLive) void this.refresh(slot.record.machineId);
    if (slot.record.member && !wasLive) this.scheduleSync();
  }

  private liveStatus(slot: Slot): MachineConnectionStatus {
    if (slot.route?.kind === "relay") return "relaying";
    const features = slot.inner?.info?.features;
    return features?.includes(NETWORK_FEATURES.network) ? "online" : "needs-update";
  }

  private onInnerStatus(slot: Slot, inner: MachineClient, status: string) {
    if (slot.inner !== inner || this.disposed) return;
    if (status === "open") {
      this.clock.clearTimeout(slot.graceTimer);
      slot.lastSeenAt = this.clock.now();
      slot.error = undefined;
      slot.status = this.liveStatus(slot);
      this.touch(slot, "status");
      void this.refresh(slot.record.machineId);
    } else if (status === "reconnecting" || status === "connecting") {
      if (LIVE.has(slot.status)) {
        slot.status = "offline";
        slot.lastSeenAt = this.clock.now();
        this.touch(slot, "status");
      }
      this.clock.clearTimeout(slot.graceTimer);
      // The client keeps trying its own route; after the grace period try the others.
      slot.graceTimer = this.clock.setTimeout(() => {
        if (slot.inner === inner && slot.status !== "paused") void this.failover(slot);
      }, this.options.reconnectGraceMs ?? 8_000);
    } else if (status === "failed" || status === "closed") {
      slot.lastSeenAt = this.clock.now();
      if (LIVE.has(slot.status)) {
        slot.status = "offline";
        this.touch(slot, "status");
      }
      void this.failover(slot);
    }
  }

  private async failover(slot: Slot): Promise<void> {
    if (slot.attempt) return;
    await this.connectSlot(slot);
  }

  /** The machine cannot be reached: keep its lists as the cache, close what was open, retry with backoff. */
  private goOffline(slot: Slot, status: "offline" | "unpaired" | "paused", error?: MachineError) {
    if (status === "paused") slot.gen++;
    this.clock.clearTimeout(slot.graceTimer);
    this.clock.clearTimeout(slot.retryTimer);
    const inner = slot.inner;
    if (inner) slot.lastSeenAt ??= this.clock.now();
    slot.offInner?.();
    slot.offInner = undefined;
    slot.inner = undefined;
    slot.route = undefined;
    slot.proxy.attach(undefined);
    inner?.close("Machine unreachable");
    slot.status = slot.record.paused ? "paused" : status;
    slot.error = slot.record.paused ? undefined : error;
    this.touch(slot, "status");
    if (slot.record.paused || this.disposed) return;
    const delay = FAILURE_DELAYS_MS[Math.min(slot.failures++, FAILURE_DELAYS_MS.length - 1)]!;
    slot.retryTimer = this.clock.setTimeout(() => void this.connectSlot(slot), delay);
  }

  // ---- routes: better ones, learned ones ----

  private scheduleProbe() {
    this.clock.clearTimeout(this.probeTimer);
    if (this.disposed) return;
    this.probeTimer = this.clock.setTimeout(async () => {
      try {
        await Promise.all(
          [...this.slots.values()].map((slot) => (LIVE.has(slot.status) ? this.probeBetter(slot) : undefined)),
        );
      } finally {
        this.scheduleProbe();
      }
    }, this.options.probeIntervalMs ?? 300_000);
  }

  /** Probe the routes ranked ahead of the one in use and move to the first that verifies, keeping subscriptions. */
  private async probeBetter(slot: Slot): Promise<void> {
    if (slot.attempt || slot.probing || !slot.route || !slot.inner || !LIVE.has(slot.status)) return;
    slot.probing = true;
    const gen = slot.gen;
    const current = slot.inner;
    try {
      const result = await this.findRoute(slot, gen, { before: routeId(slot.route) });
      if (result.kind !== "open") return;
      if (gen !== slot.gen || slot.inner !== current) {
        result.opened.inner.close("Superseded");
        return;
      }
      this.adopt(slot, result.opened);
    } catch {
      // The route in use keeps working.
    } finally {
      slot.probing = false;
    }
  }

  private learn(slot: Slot, routes: readonly Route[] | undefined) {
    if (!routes) return;
    const usable = routes.filter((route) => !!route && typeof route.url === "string" && (route.kind !== "relay" || !!route.via));
    const kept = orderRoutes(usable).slice(0, MAX_ROUTES_PER_MACHINE);
    const same = JSON.stringify(slot.record.learned ?? []) === JSON.stringify(kept);
    slot.record.learned = kept;
    if (!same) {
      this.persist();
      this.touch(slot, "routes");
    }
  }

  // ---- the network: members, tokens ----

  /** The connected member to ask: the local machine, else the nearest. */
  private bestMember(except?: Slot): Slot | undefined {
    return [...this.slots.values()]
      .filter(
        (slot) =>
          slot !== except &&
          slot.inner &&
          slot.record.member &&
          (slot.status === "online" || slot.status === "relaying") &&
          slot.inner.info?.features?.includes(NETWORK_FEATURES.network) !== false,
      )
      .sort((a, b) => {
        const local = Number(b.record.machineId === this.localId) - Number(a.record.machineId === this.localId);
        return local || (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity);
      })[0];
  }

  /** This device's token for a machine: the saved one, else one minted through a member (§3.4). */
  private async token(slot: Slot): Promise<string | undefined> {
    const saved = await this.options.credentials.get(slot.record.machineId);
    if (saved) return saved;
    const member = this.bestMember(slot);
    if (!member?.inner) return undefined;
    try {
      const grant = (await member.inner.call("network.client_grant", {
        machine_id: slot.record.machineId,
        device_id: this.options.deviceId,
      })) as NetworkClientGrantResult & { signing_key?: string | null };
      if (!grant?.token) return undefined;
      await this.options.credentials.set(slot.record.machineId, grant.token);
      if (grant.signing_key && !slot.record.signingKey) slot.record.signingKey = grant.signing_key;
      this.learn(slot, grant.routes);
      this.persist();
      return grant.token;
    } catch {
      return undefined;
    }
  }

  private scheduleSync() {
    if (this.disposed) return;
    this.clock.clearTimeout(this.syncTimer);
    this.syncTimer = this.clock.setTimeout(() => void this.syncMembers(), 300);
  }

  /**
   * Ask a member for the network and make the machine list match: new members
   * are added, ones removed anywhere are forgotten here, names, pauses and
   * routes follow. Machines that are not members (older daemons saved by the
   * user) are never touched.
   */
  async syncMembers(): Promise<void> {
    if (this.syncing) return this.syncing;
    const run = (async () => {
      const source = this.bestMember();
      if (!source?.inner) return;
      let members: (MachineCard & { signing_key?: string | null })[];
      let selfId: MachineId;
      try {
        const status = await source.inner.call("network.status", {});
        members = status.members;
        selfId = status.self_machine.machine_id;
      } catch {
        return;
      }
      // A list that does not even contain the machine that served it is not a network list.
      if (this.disposed || !members.some((card) => card.machine_id === selfId)) return;
      const ids = new Set(members.map((card) => card.machine_id));
      const fresh: Slot[] = [];
      for (const card of members) {
        let slot = this.slots.get(card.machine_id);
        if (!slot) {
          if (this.slots.size >= (this.options.maxMachines ?? 32)) continue;
          slot = this.createSlot({
            machineId: card.machine_id,
            name: card.name,
            os: card.os,
            routes: [],
            member: true,
            paused: card.status === "paused",
            ...(card.signing_key ? { signingKey: card.signing_key } : {}),
          });
          fresh.push(slot);
        } else {
          const record = slot.record;
          const paused = card.status === "paused";
          const changed = record.name !== card.name || record.os !== card.os || !record.member || !!record.paused !== paused;
          record.name = card.name;
          record.os = card.os;
          record.member = true;
          if (card.signing_key && !record.signingKey) record.signingKey = card.signing_key;
          if (!!record.paused !== paused) {
            record.paused = paused;
            if (paused) this.goOffline(slot, "paused");
            else fresh.push(slot);
          }
          if (changed) this.touch(slot, "records");
        }
      }
      for (const slot of [...this.slots.values()])
        if (slot.record.member && !ids.has(slot.record.machineId)) await this.removeMachine(slot.record.machineId);
      for (const slot of this.slots.values()) {
        if (!slot.record.member || slot === source) continue;
        try {
          const result = await source.inner!.call("network.routes", { machine_id: slot.record.machineId });
          this.learn(slot, result.routes);
        } catch {
          // Routes are refreshed on the next sync.
        }
      }
      this.persist();
      this.touch(undefined, "records");
      await mapLimit(fresh, 4, (slot) => this.connectSlot(slot));
    })();
    this.syncing = run.finally(() => {
      this.syncing = undefined;
    });
    return this.syncing;
  }
}
