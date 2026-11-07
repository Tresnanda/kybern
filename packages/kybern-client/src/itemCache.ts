import { TranscriptCache, memoryTranscriptCacheStore, type TranscriptCacheStore } from './transcriptCache.ts';

/** Notes and tasks use the transcript cache's schema validation, byte bounds and LRU. */
export class ItemCache {
  private readonly cache: TranscriptCache<unknown>;
  private readonly store: TranscriptCacheStore;
  constructor(store: TranscriptCacheStore = memoryTranscriptCacheStore()) {
    this.store = store;
    this.cache = new TranscriptCache(store, { schema: 1 });
  }
  private key(method: string, params: unknown): string {
    return `${method}:${JSON.stringify(params ?? {})}`;
  }
  async read(machine: string, method: string, params: unknown): Promise<unknown> {
    const saved = (await this.cache.load(machine, this.key(method, params)))?.data;
    if (saved !== undefined || method !== 'tasks.items.get') return saved;
    const list = (await this.cache.load(machine, this.key('tasks.items.list', {})))?.data as { tasks?: { id: string; key?: string }[] } | undefined;
    const query = params as { id?: string; key?: string };
    const task = list?.tasks?.find(t => query.id ? t.id === query.id : t.key === query.key);
    return task ? { task } : undefined;
  }
  async put(machine: string, method: string, params: unknown, value: unknown): Promise<void> {
    this.cache.schedule(machine, this.key(method, params), () => ({ lastSeq: 0, data: value }));
    await this.cache.flush();
    if (method === 'notes.list' || method === 'tasks.items.list') {
      const key = method === 'notes.list' ? 'notes' : 'tasks';
      const list = value as { notes?: { id: string }[]; tasks?: { id: string }[]; federation?: { sections?: { machine_id: string; ids: string[] }[] } };
      const sections = list.federation?.sections;
      if (sections) for (const section of sections) {
        const ids = new Set(section.ids);
        await this.put(section.machine_id, method, {}, { [key]: (list[key] ?? []).filter(row => ids.has(row.id)) });
      }

    }
  }
  async removeMachine(machine: string): Promise<void> {
    await this.cache.flush();
    await this.cache.wipeMachine(machine);
    // Federated lists also contain this owner's rows under the answering machine.
    for (const row of await this.store.index()) {
      const saved = await this.cache.load(row.machineId, row.threadId);
      const value = saved?.data as ItemList | undefined;
      const removed = value?.federation?.sections?.filter(section => section.machine_id === machine);
      if (!removed?.length) continue;
      const ids = new Set(removed.flatMap(section => section.ids));
      const data = { ...value,
        ...(value?.notes ? { notes: value.notes.filter(note => !ids.has(note.id)) } : {}),
        ...(value?.tasks ? { tasks: value.tasks.filter(task => !ids.has(task.id)) } : {}),
        federation: { ...value?.federation, sections: value?.federation?.sections?.filter(section => section.machine_id !== machine) }
      };
      this.cache.schedule(row.machineId, row.threadId, () => ({ lastSeq: 0, data }));
    }
    await this.cache.flush();
  }
}

export const isItemRead = (method: string): boolean =>
  ['notes.list', 'notes.get', 'tasks.items.list', 'tasks.items.get'].includes(method);
export const isItemEdit = (method: string): boolean =>
  method === 'notes.update' || method === 'tasks.items.update';
/** Keep offline members visible without presenting cached rows as fresh reads. */
interface ItemList {
  notes?: { id: string }[];
  tasks?: { id: string }[];
  federation?: {
    sections?: { machine_id: string; machine_name?: string; ids: string[]; stale?: boolean }[];
    skipped?: { machine_id: string; machine_name: string; reason: string }[];
    footer?: string | null;
  };
}
export function mergeOfflineItems(currentValue: unknown, previousValue: unknown, method: string): unknown {
  const current = currentValue as ItemList | undefined;
  const previous = previousValue as ItemList | undefined;
  const key = method === 'notes.list' ? 'notes' : 'tasks';
  if (!Array.isArray(current?.[key]) || !Array.isArray(previous?.[key])) return currentValue;
  const sections = [...(current!.federation?.sections ?? [])];
  const rows = [...current![key]!];
  const seen = new Set(rows.map((r) => r.id));
  const cached: string[] = [];
  for (const skipped of current.federation?.skipped ?? []) {
    if (skipped.reason !== 'offline' && skipped.reason !== 'paused') continue;
    const old = previous!.federation?.sections?.find((s) => s.machine_id === skipped.machine_id);
    if (!old) continue;
    const ids = new Set(old.ids);
    const kept = previous![key]!.filter((r) => ids.has(r.id) && !seen.has(r.id));
    if (!kept.length) continue;
    rows.push(...kept);
    kept.forEach((r) => seen.add(r.id));
    sections.push({ ...old, stale: true });
    cached.push(skipped.machine_name);
  }
  if (!cached.length) return current;
  return { ...current, [key]: rows, federation: { ...current.federation, sections,
    footer: `Showing cached ${key} for ${cached.join(', ')}. Reconnect their machines to refresh.` } };
}
