// A disk cache of opened transcripts (#248). A client draws the cached copy of a
// thread on its first frame and resumes the event stream from the cached
// `lastSeq`. The cache is storage-agnostic: GPUIX backs it with `bun:sqlite`,
// mobile with `expo-sqlite`, both through `sqliteTranscriptCacheStore`.
//
// Rules: a record holds one snapshot and the cursor it reflects, written only
// after an update fully applied (`schedule` reads both at write time); every
// record carries the client's schema version, and a mismatched or unreadable
// record is deleted and treated as a miss; the least recently used records go
// first past 64 threads or 64 MB; writes are behind (500 ms after the first
// change, then at most every 10 s per thread); removing a machine or unpairing
// wipes its records.

type Awaitable<T> = T | Promise<T>;

export interface TranscriptCacheRow {
  machineId: string;
  threadId: string;
  /** The client's record schema; a different one is never read. */
  schema: number;
  /** The event sequence the snapshot reflects; the resume cursor. */
  lastSeq: number;
  /** Size of `body`, used for the byte bound. */
  bytes: number;
  /** Last read or write, in ms since the epoch; the LRU clock. */
  usedAt: number;
  /** The serialized snapshot. */
  body: string;
}

export type TranscriptCacheIndexRow = Pick<TranscriptCacheRow, "machineId" | "threadId" | "bytes" | "usedAt">;

export interface TranscriptCacheStore {
  read(machineId: string, threadId: string): Awaitable<TranscriptCacheRow | null | undefined>;
  write(row: TranscriptCacheRow): Awaitable<void>;
  touch(machineId: string, threadId: string, usedAt: number): Awaitable<void>;
  remove(machineId: string, threadId: string): Awaitable<void>;
  removeMachine(machineId: string): Awaitable<void>;
  clear(): Awaitable<void>;
  /** Every record's key, size and LRU clock, without bodies. */
  index(): Awaitable<TranscriptCacheIndexRow[]>;
}

export interface TranscriptCacheLimits {
  maxEntries: number;
  maxBytes: number;
}

export const TRANSCRIPT_CACHE_LIMITS: TranscriptCacheLimits = {
  maxEntries: 64,
  maxBytes: 64 * 1024 * 1024,
};

export interface TranscriptCacheTiming {
  /** Delay of a thread's first write after its first change. */
  firstDelayMs: number;
  /** Minimum time between two writes of the same thread. */
  intervalMs: number;
}

export const TRANSCRIPT_CACHE_TIMING: TranscriptCacheTiming = { firstDelayMs: 500, intervalMs: 10_000 };

export interface CachedTranscript<T> {
  lastSeq: number;
  data: T;
}

interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface TranscriptCacheOptions<T> {
  /** The client's record schema version. Bump it whenever `T` changes shape. */
  schema: number;
  limits?: Partial<TranscriptCacheLimits>;
  timing?: Partial<TranscriptCacheTiming>;
  /** Rejects a parsed body that is not a usable `T`; the record is then deleted. */
  validate?: (data: unknown) => data is T;
  now?: () => number;
  timers?: Timers;
  /** Storage failures never throw into the caller; they are reported here. */
  onError?: (error: unknown) => void;
}

type Read<T> = () => CachedTranscript<T> | undefined;

interface Pending<T> {
  read: Read<T>;
  timer: unknown;
}

const keyOf = (machineId: string, threadId: string) => `${machineId}\u0000${threadId}`;

export class TranscriptCache<T> {
  private readonly store: TranscriptCacheStore;
  private readonly schema: number;
  private readonly limits: TranscriptCacheLimits;
  private readonly timing: TranscriptCacheTiming;
  private readonly validate: ((data: unknown) => data is T) | undefined;
  private readonly now: () => number;
  private readonly timers: Timers;
  private readonly onError: (error: unknown) => void;
  /** Known records without bodies, loaded once from the store. */
  private index: Map<string, TranscriptCacheIndexRow> | undefined;
  private indexLoad: Promise<Map<string, TranscriptCacheIndexRow>> | undefined;
  private readonly pending = new Map<string, Pending<T>>();
  private readonly lastWrite = new Map<string, number>();
  /** Store operations run one at a time, in order. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(store: TranscriptCacheStore, options: TranscriptCacheOptions<T>) {
    this.store = store;
    this.schema = options.schema;
    this.limits = { ...TRANSCRIPT_CACHE_LIMITS, ...options.limits };
    this.timing = { ...TRANSCRIPT_CACHE_TIMING, ...options.timing };
    this.validate = options.validate;
    this.now = options.now ?? Date.now;
    this.timers = options.timers ?? {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
    this.onError = options.onError ?? (() => {});
  }

  /** The cached copy of a thread, or nothing. Never throws. */
  load(machineId: string, threadId: string): Promise<CachedTranscript<T> | undefined> {
    return this.serial(async () => {
      const index = await this.loadIndex();
      const key = keyOf(machineId, threadId);
      const row = await this.store.read(machineId, threadId);
      if (!row) {
        index.delete(key);
        return undefined;
      }
      const data = this.decode(row);
      if (data === undefined) {
        index.delete(key);
        await this.store.remove(machineId, threadId);
        return undefined;
      }
      const usedAt = this.now();
      index.set(key, { machineId, threadId, bytes: row.bytes, usedAt });
      await this.store.touch(machineId, threadId, usedAt);
      return { lastSeq: row.lastSeq, data };
    }, undefined);
  }

  /** Whether a record exists, from the index only (no body read). */
  async has(machineId: string, threadId: string): Promise<boolean> {
    const index = await this.serial(() => this.loadIndex(), new Map());
    return index.has(keyOf(machineId, threadId));
  }

  /**
   * Save this thread behind: `read` is called at write time and must return the
   * snapshot and the cursor it reflects together, or nothing to skip the write.
   * Call it only after an update fully applied.
   */
  schedule(machineId: string, threadId: string, read: Read<T>): void {
    const key = keyOf(machineId, threadId);
    const existing = this.pending.get(key);
    if (existing) {
      existing.read = read;
      return;
    }
    const last = this.lastWrite.get(key);
    const now = this.now();
    const delay =
      last === undefined
        ? this.timing.firstDelayMs
        : Math.max(this.timing.firstDelayMs, last + this.timing.intervalMs - now);
    const entry: Pending<T> = { read, timer: undefined };
    entry.timer = this.timers.setTimeout(() => void this.writePending(machineId, threadId), delay);
    this.pending.set(key, entry);
  }

  /** Write every scheduled save now (app going to the background, window closing). */
  async flush(): Promise<void> {
    const keys = [...this.pending.values()];
    for (const entry of keys) this.timers.clearTimeout(entry.timer);
    const writes = [...this.pending.keys()].map((key) => {
      const [machineId, threadId] = key.split("\u0000") as [string, string];
      return this.writePending(machineId, threadId);
    });
    await Promise.all(writes);
    await this.queue;
  }

  /** Drop one thread's record (deleted or archived thread). */
  forget(machineId: string, threadId: string): Promise<void> {
    const key = keyOf(machineId, threadId);
    this.cancel(key);
    return this.serial(async () => {
      (await this.loadIndex()).delete(key);
      await this.store.remove(machineId, threadId);
    }, undefined);
  }

  /** Remove everything cached for a machine that left the network. */
  wipeMachine(machineId: string): Promise<void> {
    for (const key of [...this.pending.keys()]) if (key.startsWith(`${machineId}\u0000`)) this.cancel(key);
    return this.serial(async () => {
      const index = await this.loadIndex();
      for (const [key, row] of index) if (row.machineId === machineId) index.delete(key);
      await this.store.removeMachine(machineId);
    }, undefined);
  }

  /** Remove everything (unpaired). */
  clear(): Promise<void> {
    for (const key of [...this.pending.keys()]) this.cancel(key);
    return this.serial(async () => {
      (await this.loadIndex()).clear();
      await this.store.clear();
    }, undefined);
  }

  /** Records and bytes held, for diagnostics and tests. */
  async stats(): Promise<{ entries: number; bytes: number }> {
    const index = await this.serial(() => this.loadIndex(), new Map());
    let bytes = 0;
    for (const row of index.values()) bytes += row.bytes;
    return { entries: index.size, bytes };
  }

  private cancel(key: string) {
    const entry = this.pending.get(key);
    if (entry) this.timers.clearTimeout(entry.timer);
    this.pending.delete(key);
  }

  private writePending(machineId: string, threadId: string): Promise<void> {
    const key = keyOf(machineId, threadId);
    const entry = this.pending.get(key);
    if (!entry) return Promise.resolve();
    this.pending.delete(key);
    let snapshot: CachedTranscript<T> | undefined;
    try {
      snapshot = entry.read();
    } catch (error) {
      this.onError(error);
      return Promise.resolve();
    }
    if (!snapshot) return Promise.resolve();
    let body: string;
    try {
      body = JSON.stringify(snapshot.data);
    } catch (error) {
      this.onError(error);
      return Promise.resolve();
    }
    const usedAt = this.now();
    this.lastWrite.set(key, usedAt);
    const row: TranscriptCacheRow = {
      machineId,
      threadId,
      schema: this.schema,
      lastSeq: snapshot.lastSeq,
      bytes: body.length,
      usedAt,
      body,
    };
    return this.serial(async () => {
      const index = await this.loadIndex();
      // One record larger than the whole budget is never kept.
      if (row.bytes > this.limits.maxBytes) {
        if (index.delete(key)) await this.store.remove(machineId, threadId);
        return;
      }
      await this.store.write(row);
      index.set(key, { machineId, threadId, bytes: row.bytes, usedAt });
      await this.evict(key);
    }, undefined);
  }

  private async evict(keep: string) {
    const index = await this.loadIndex();
    let bytes = 0;
    for (const row of index.values()) bytes += row.bytes;
    if (index.size <= this.limits.maxEntries && bytes <= this.limits.maxBytes) return;
    const oldestFirst = [...index.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt);
    for (const [key, row] of oldestFirst) {
      if (index.size <= this.limits.maxEntries && bytes <= this.limits.maxBytes) break;
      if (key === keep) continue;
      index.delete(key);
      bytes -= row.bytes;
      await this.store.remove(row.machineId, row.threadId);
    }
  }

  private decode(row: TranscriptCacheRow): T | undefined {
    if (row.schema !== this.schema || typeof row.body !== "string" || !Number.isFinite(row.lastSeq)) return undefined;
    try {
      const data: unknown = JSON.parse(row.body);
      if (data === null || data === undefined) return undefined;
      if (this.validate && !this.validate(data)) return undefined;
      return data as T;
    } catch {
      return undefined;
    }
  }

  private loadIndex(): Promise<Map<string, TranscriptCacheIndexRow>> {
    if (this.index) return Promise.resolve(this.index);
    this.indexLoad ??= (async () => {
      const map = new Map<string, TranscriptCacheIndexRow>();
      for (const row of await this.store.index()) map.set(keyOf(row.machineId, row.threadId), row);
      this.index = map;
      return map;
    })();
    return this.indexLoad;
  }

  private serial<R>(task: () => Promise<R>, fallback: R): Promise<R> {
    const run = this.queue.then(task).catch((error: unknown) => {
      this.onError(error);
      // A failed index load is retried on the next operation.
      if (!this.index) this.indexLoad = undefined;
      return fallback;
    });
    this.queue = run;
    return run;
  }
}

/** The minimal SQLite surface both clients have: bun:sqlite and expo-sqlite adapt to it in a few lines. */
export interface SqlDatabase {
  run(sql: string, params: readonly (string | number)[]): Awaitable<unknown>;
  get<R>(sql: string, params: readonly (string | number)[]): Awaitable<R | null | undefined>;
  all<R>(sql: string, params: readonly (string | number)[]): Awaitable<R[]>;
}

export const TRANSCRIPT_CACHE_TABLE = `CREATE TABLE IF NOT EXISTS transcript_cache (
  machine_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  schema INTEGER NOT NULL,
  last_seq INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  used_at INTEGER NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (machine_id, thread_id)
)`;

interface SqlRow {
  machine_id: string;
  thread_id: string;
  schema: number;
  last_seq: number;
  bytes: number;
  used_at: number;
  body: string;
}

/** A `TranscriptCacheStore` over one SQLite table. Call `TRANSCRIPT_CACHE_TABLE` once before use (`ensure`). */
export function sqliteTranscriptCacheStore(db: SqlDatabase): TranscriptCacheStore & { ensure(): Awaitable<unknown> } {
  return {
    ensure: () => db.run(TRANSCRIPT_CACHE_TABLE, []),
    async read(machineId, threadId) {
      const row = await db.get<SqlRow>(
        "SELECT machine_id, thread_id, schema, last_seq, bytes, used_at, body FROM transcript_cache WHERE machine_id = ? AND thread_id = ?",
        [machineId, threadId],
      );
      if (!row) return undefined;
      return {
        machineId: row.machine_id,
        threadId: row.thread_id,
        schema: Number(row.schema),
        lastSeq: Number(row.last_seq),
        bytes: Number(row.bytes),
        usedAt: Number(row.used_at),
        body: row.body,
      };
    },
    async write(row) {
      await db.run(
        "INSERT OR REPLACE INTO transcript_cache (machine_id, thread_id, schema, last_seq, bytes, used_at, body) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [row.machineId, row.threadId, row.schema, row.lastSeq, row.bytes, row.usedAt, row.body],
      );
    },
    async touch(machineId, threadId, usedAt) {
      await db.run("UPDATE transcript_cache SET used_at = ? WHERE machine_id = ? AND thread_id = ?", [usedAt, machineId, threadId]);
    },
    async remove(machineId, threadId) {
      await db.run("DELETE FROM transcript_cache WHERE machine_id = ? AND thread_id = ?", [machineId, threadId]);
    },
    async removeMachine(machineId) {
      await db.run("DELETE FROM transcript_cache WHERE machine_id = ?", [machineId]);
    },
    async clear() {
      await db.run("DELETE FROM transcript_cache", []);
    },
    async index() {
      const rows = await db.all<Pick<SqlRow, "machine_id" | "thread_id" | "bytes" | "used_at">>(
        "SELECT machine_id, thread_id, bytes, used_at FROM transcript_cache",
        [],
      );
      return rows.map((row) => ({
        machineId: row.machine_id,
        threadId: row.thread_id,
        bytes: Number(row.bytes),
        usedAt: Number(row.used_at),
      }));
    },
  };
}

/** An in-memory store, for tests and for clients without disk access. */
export function memoryTranscriptCacheStore(): TranscriptCacheStore & { rows: Map<string, TranscriptCacheRow> } {
  const rows = new Map<string, TranscriptCacheRow>();
  return {
    rows,
    read: (machineId, threadId) => rows.get(keyOf(machineId, threadId)),
    write: (row) => void rows.set(keyOf(row.machineId, row.threadId), { ...row }),
    touch: (machineId, threadId, usedAt) => {
      const row = rows.get(keyOf(machineId, threadId));
      if (row) row.usedAt = usedAt;
    },
    remove: (machineId, threadId) => void rows.delete(keyOf(machineId, threadId)),
    removeMachine: (machineId) => {
      for (const [key, row] of rows) if (row.machineId === machineId) rows.delete(key);
    },
    clear: () => rows.clear(),
    index: () => [...rows.values()].map(({ machineId, threadId, bytes, usedAt }) => ({ machineId, threadId, bytes, usedAt })),
  };
}
