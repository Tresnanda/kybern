// A bounded offline cache of each machine's lists (design §5.1): the last
// projects and the newest thread summaries, never transcripts. The cache is
// storage-agnostic: GPUIX hands it a file in the client config dir, mobile a
// file from expo-file-system. A machine's entry is always replaced whole.
import type { Project, Thread } from "./types.ts";

export interface CacheStorage {
  /** The whole cache as text, or nothing when none is saved. */
  read(): string | null | undefined | Promise<string | null | undefined>;
  write(text: string): void | Promise<void>;
}

export interface CacheLimits {
  /** Newest thread summaries kept per machine. */
  threadsPerMachine: number;
  projectsPerMachine: number;
  /** Machines kept; the least recently saved go first. */
  machines: number;
  /** Serialized size of one machine's entry; the oldest threads go first. */
  bytesPerMachine: number;
}

export const DEFAULT_CACHE_LIMITS: CacheLimits = {
  threadsPerMachine: 300,
  projectsPerMachine: 500,
  machines: 16,
  bytesPerMachine: 1024 * 1024,
};

export interface MachineSnapshot {
  machineId: string;
  /** When this machine's lists were last read from it, in ms since the epoch. */
  savedAt: number;
  projects: Project[];
  threads: Thread[];
}

const VERSION = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rows<T extends { id: string }>(value: unknown): T[] {
  return Array.isArray(value) ? (value.filter((row) => isRecord(row) && typeof row.id === "string") as T[]) : [];
}

/** Newest first; `updated_at` is RFC 3339 so text order is time order. */
function newestFirst(a: Thread, b: Thread): number {
  return (b.updated_at ?? "").localeCompare(a.updated_at ?? "");
}

export class MachineCache {
  private readonly limits: CacheLimits;
  private readonly entries = new Map<string, MachineSnapshot>();
  private writing: Promise<void> = Promise.resolve();
  private dirty = false;

  private readonly storage: CacheStorage | undefined;

  constructor(storage?: CacheStorage, limits: Partial<CacheLimits> = {}) {
    this.storage = storage;
    this.limits = { ...DEFAULT_CACHE_LIMITS, ...limits };
  }

  /** Read what was saved. A damaged or unknown-version file is ignored, never thrown. */
  async load(): Promise<void> {
    let text: string | null | undefined;
    try {
      text = await this.storage?.read();
    } catch {
      return;
    }
    if (!text) return;
    try {
      const data: unknown = JSON.parse(text);
      if (!isRecord(data) || data.v !== VERSION || !Array.isArray(data.machines)) return;
      for (const raw of data.machines) {
        if (!isRecord(raw) || typeof raw.machineId !== "string" || typeof raw.savedAt !== "number") continue;
        // A fresher put() made before load finished wins.
        if (this.entries.has(raw.machineId)) continue;
        this.entries.set(
          raw.machineId,
          this.bounded({
            machineId: raw.machineId,
            savedAt: raw.savedAt,
            projects: rows<Project>(raw.projects),
            threads: rows<Thread>(raw.threads),
          }),
        );
      }
      this.evict();
    } catch {
      // Damaged file: start empty.
    }
  }

  get(machineId: string): MachineSnapshot | undefined {
    return this.entries.get(machineId);
  }

  machineIds(): string[] {
    return [...this.entries.keys()];
  }

  /** Replace this machine's entry with a fresh read. Nothing of the old entry survives. */
  put(machineId: string, lists: { projects: readonly Project[]; threads: readonly Thread[] }, savedAt: number): MachineSnapshot {
    const snapshot = this.bounded({
      machineId,
      savedAt,
      projects: [...lists.projects],
      threads: [...lists.threads],
    });
    this.entries.delete(machineId);
    this.entries.set(machineId, snapshot);
    this.evict();
    this.persist();
    return snapshot;
  }

  delete(machineId: string): void {
    if (this.entries.delete(machineId)) this.persist();
  }

  /** Resolves when everything put so far is written. */
  async flush(): Promise<void> {
    await this.writing;
  }

  private bounded(snapshot: MachineSnapshot): MachineSnapshot {
    const { threadsPerMachine, projectsPerMachine, bytesPerMachine } = this.limits;
    let threads = [...snapshot.threads].sort(newestFirst).slice(0, threadsPerMachine);
    let projects = snapshot.projects.slice(0, projectsPerMachine);
    let size = JSON.stringify({ projects, threads }).length;
    while (size > bytesPerMachine && threads.length > 0) {
      threads = threads.slice(0, Math.floor(threads.length * 0.8));
      size = JSON.stringify({ projects, threads }).length;
    }
    while (size > bytesPerMachine && projects.length > 0) {
      projects = projects.slice(0, Math.floor(projects.length * 0.8));
      size = JSON.stringify({ projects, threads }).length;
    }
    return { machineId: snapshot.machineId, savedAt: snapshot.savedAt, projects, threads };
  }

  private evict() {
    if (this.entries.size <= this.limits.machines) return;
    const keep = [...this.entries.values()]
      .sort((a, b) => b.savedAt - a.savedAt)
      .slice(0, this.limits.machines)
      .map((entry) => entry.machineId);
    for (const id of [...this.entries.keys()]) if (!keep.includes(id)) this.entries.delete(id);
  }

  /** Writes are serialized and coalesced: several puts in a row write once. */
  private persist() {
    if (!this.storage || this.dirty) return;
    this.dirty = true;
    this.writing = this.writing.then(async () => {
      this.dirty = false;
      try {
        await this.storage?.write(JSON.stringify({ v: VERSION, machines: [...this.entries.values()] }));
      } catch {
        // A full disk must not break the app; the next put writes again.
      }
    });
  }
}
