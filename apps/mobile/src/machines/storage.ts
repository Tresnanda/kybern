// What the phone remembers about its machines (design §5.3): the records in one
// SecureStore item, each machine's device token in an item of its own, and the
// device id `network.client_grant` mints tokens for. The saved computers of
// earlier versions (`kybern.ink.environments`, tokens inside the one JSON) move
// here once. The key-value store is injected so this runs in tests.
import type { CredentialStore, MachineRecord, MachineStore } from "../../../../packages/kybern-client/src/machines";
import { recordOfComputer, type SavedComputer } from "./records";

export interface KeyValue {
  get(key: string): Promise<string | null | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export const RECORDS_KEY = "kybern.ink.machines";
export const ACTIVE_KEY = "kybern.ink.active";
export const DEVICE_KEY = "kybern.ink.device";
export const LEGACY_KEY = "kybern.ink.environments";
const TOKEN_PREFIX = "kybern.ink.token.";
const MAX_RECORDS = 32;

/** SecureStore keys take letters, digits, `.`, `-` and `_`. */
export const tokenKey = (machineId: string) => `${TOKEN_PREFIX}${machineId.replace(/[^A-Za-z0-9._-]/g, "_")}`;

const isRecord = (value: unknown): value is MachineRecord =>
  !!value &&
  typeof value === "object" &&
  typeof (value as MachineRecord).machineId === "string" &&
  typeof (value as MachineRecord).name === "string" &&
  Array.isArray((value as MachineRecord).routes);

async function readJson(kv: KeyValue, key: string): Promise<unknown> {
  try {
    const raw = await kv.get(key);
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

export interface LoadedMachines {
  records: MachineRecord[];
  /** The machine the phone is at: where its primary connection goes. */
  activeId: string | null;
}

/**
 * Saved computers become records, their tokens move to per-machine items, and the
 * old item is deleted once the new ones read back. Returns undefined when there is
 * nothing to migrate or the records already exist.
 */
export async function migrateLegacy(kv: KeyValue): Promise<LoadedMachines | undefined> {
  const legacy = (await readJson(kv, LEGACY_KEY)) as
    | { environments?: (SavedComputer & { token?: string })[]; activeId?: string | null }
    | undefined;
  if (!legacy || !Array.isArray(legacy.environments)) return undefined;
  const computers = legacy.environments.filter(
    (e) => typeof e?.id === "string" && typeof e.token === "string" && typeof e.url === "string",
  );
  const records: MachineRecord[] = [];
  let activeId: string | null = null;
  for (const computer of computers.slice(0, MAX_RECORDS)) {
    const record = recordOfComputer(computer);
    if (records.some((other) => other.machineId === record.machineId)) continue;
    // A computer's own id is its record's profile id: that is how the phone finds its token and active choice.
    await kv.set(tokenKey(record.machineId), computer.token!);
    records.push(record);
    if (legacy.activeId === computer.id) activeId = record.machineId;
  }
  await kv.set(RECORDS_KEY, JSON.stringify({ version: 1, records }));
  if (activeId) await kv.set(ACTIVE_KEY, activeId);
  // The tokens now live elsewhere: forget the old copy only after the new one reads back.
  const back = records.length ? await kv.get(tokenKey(records[0]!.machineId)) : "ok";
  if (back) await kv.delete(LEGACY_KEY);
  return { records, activeId };
}

export async function loadMachines(kv: KeyValue): Promise<LoadedMachines> {
  const saved = (await readJson(kv, RECORDS_KEY)) as { records?: unknown[] } | undefined;
  if (!saved) return (await migrateLegacy(kv)) ?? { records: [], activeId: null };
  const records = (Array.isArray(saved.records) ? saved.records : []).filter(isRecord).slice(0, MAX_RECORDS);
  let activeId: string | null = null;
  try {
    activeId = (await kv.get(ACTIVE_KEY)) || null;
  } catch {
    activeId = null;
  }
  return { records, activeId: records.some((r) => r.machineId === activeId) ? activeId : null };
}

export async function saveActive(kv: KeyValue, activeId: string | null): Promise<void> {
  if (activeId) await kv.set(ACTIVE_KEY, activeId);
  else await kv.delete(ACTIVE_KEY);
}

/** The `MachineSet`'s record store: every change is written whole. */
export function machineStore(kv: KeyValue, initial?: () => MachineRecord[]): MachineStore {
  return {
    load: async () => initial?.() ?? (await loadMachines(kv)).records,
    save: async (records) => {
      await kv.set(RECORDS_KEY, JSON.stringify({ version: 1, records }));
    },
  };
}

/** One token per machine. Unreadable is the same as absent: the machine is then "unpaired" until a member mints one. */
export function machineCredentials(kv: KeyValue): CredentialStore {
  return {
    get: async (machineId) => {
      try {
        return (await kv.get(tokenKey(machineId))) || undefined;
      } catch {
        return undefined;
      }
    },
    set: (machineId, token) => kv.set(tokenKey(machineId), token),
    delete: (machineId) => kv.delete(tokenKey(machineId)),
  };
}

/** This phone's id for `network.client_grant`, made once. */
export async function deviceId(kv: KeyValue, random: () => string): Promise<string> {
  try {
    const saved = await kv.get(DEVICE_KEY);
    if (saved) return saved;
  } catch {
    // Made again below.
  }
  const made = `phone-${random()}`;
  try {
    await kv.set(DEVICE_KEY, made);
  } catch {
    // A device id that does not survive a launch costs one extra token at the next launch.
  }
  return made;
}
