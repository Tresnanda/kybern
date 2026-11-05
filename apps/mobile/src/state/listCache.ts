// The last notes and tasks lists of each machine, kept on the phone (#245, #248), beside the
// machine set's own cache of projects and threads (`machines/cacheFile.ts`). A machine that is
// away, or has not answered yet after a cold start, shows them read-only. Bounded: the newest
// lists per machine only, a few machines, and a size cap; losing the file only costs the cache.

const VERSION = 1;
const WRITE_DELAY_MS = 2000;
const MAX_MACHINES = 8;
const MAX_ITEMS = 500;
const MAX_BYTES = 1024 * 1024;

export type ListKind = "notes" | "tasks";

export interface ListCacheStorage {
  read(): string | null;
  write(text: string): void;
}

type Entry = { savedAt: number; items: unknown[] };
type Data = { v: number; machines: Record<string, Partial<Record<ListKind, Entry>>> };

export class ListCache {
  private data: Data | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly storage: ListCacheStorage;
  private readonly delayMs: number;
  constructor(storage: ListCacheStorage, delayMs = WRITE_DELAY_MS) {
    this.storage = storage;
    this.delayMs = delayMs;
  }

  private load(): Data {
    if (this.data) return this.data;
    let data: Data = { v: VERSION, machines: {} };
    try {
      const text = this.storage.read();
      const parsed = text ? (JSON.parse(text) as Data) : null;
      if (parsed && parsed.v === VERSION && parsed.machines && typeof parsed.machines === "object") data = parsed;
    } catch {
      // A damaged file starts empty.
    }
    this.data = data;
    return data;
  }

  get<T>(machineId: string | undefined, kind: ListKind): T[] | undefined {
    if (!machineId) return undefined;
    const items = this.load().machines[machineId]?.[kind]?.items;
    return Array.isArray(items) ? (items as T[]) : undefined;
  }

  put(machineId: string | undefined, kind: ListKind, items: readonly unknown[]) {
    if (!machineId) return;
    const data = this.load();
    let kept = items.slice(0, MAX_ITEMS);
    while (kept.length && JSON.stringify(kept).length > MAX_BYTES) kept = kept.slice(0, Math.floor(kept.length * 0.8));
    data.machines[machineId] = { ...data.machines[machineId], [kind]: { savedAt: Date.now(), items: kept } };
    const ids = Object.keys(data.machines);
    if (ids.length > MAX_MACHINES) {
      const newest = (id: string) => Math.max(...Object.values(data.machines[id] ?? {}).map((entry) => entry?.savedAt ?? 0));
      for (const id of ids.sort((a, b) => newest(b) - newest(a)).slice(MAX_MACHINES)) delete data.machines[id];
    }
    this.schedule();
  }

  /** A machine left this phone: its lists go. */
  wipeMachine(machineId: string) {
    const data = this.load();
    if (!data.machines[machineId]) return;
    delete data.machines[machineId];
    this.schedule();
  }

  clear() {
    this.data = { v: VERSION, machines: {} };
    this.schedule();
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.data) this.storage.write(JSON.stringify(this.data));
  }

  private schedule() {
    this.timer ??= setTimeout(() => this.flush(), this.delayMs);
  }
}

let storage: ListCacheStorage = { read: () => null, write: () => {} };
let shared: ListCache | undefined;
/** Where the app's list cache lives; `runtime.ts` sets the document-folder file at boot (`listCacheFile.ts`). */
export function setListCacheStorage(next: ListCacheStorage) {
  storage = next;
  shared = undefined;
}
/** The app's list cache. Without storage (tests, before boot) it keeps nothing. */
export function listCache(): ListCache {
  return (shared ??= new ListCache(storage));
}
