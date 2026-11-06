// Notes and tasks across the network (#245; design §9.2, as `apps/gpuix/src/machines/federated.ts`).
//
// Reads go through the network client: the computer the phone is at while it answers, else the
// nearest live member. With more than one machine the list asks for `machine: "all"`, which the
// answering machine merges from every member it reaches; `federation.sections` says which machine
// holds which item. Writes to an item go to the machine that holds it; a new item is made on the
// answering machine. An item whose machine is away stays in the list from the last read (the
// phone's offline copy) and is read-only until that machine is back.
//
// Pure: `runtime.ts` installs the routing (`setNetworkRouting`); without it (tests, before boot)
// the stores use the client they were attached to.
import type { KybernClient } from "../../../../packages/kybern-client/src/client";
import { MACHINE_ALL, type Federation, type MachineId } from "../../../../packages/kybern-client/src/types";

export type FederatedKind = "notes" | "tasks";

export interface NetworkTarget {
  client: KybernClient;
  /** The machine that answers (undefined when unknown, e.g. a single computer before it answered). */
  machineId?: MachineId;
}

export interface NetworkRouting {
  /** The client for network-wide reads and new items, or null while nothing answers. */
  network(): NetworkTarget | null;
  /** One machine's client while it answers, else null. */
  machine(machineId: MachineId): KybernClient | null;
  /** What the machine is called on screen. */
  name(machineId: MachineId): string;
  /** More than one machine is known: lists ask for every machine's items. */
  multiple(): boolean;
}

let routing: NetworkRouting | null = null;
export function setNetworkRouting(next: NetworkRouting | null) {
  routing = next;
}

const owners: Record<FederatedKind, Map<string, MachineId>> = { notes: new Map(), tasks: new Map() };
const NOUN: Record<FederatedKind, string> = { notes: "notes", tasks: "tasks" };

/** The target of a store: the network's when routing is installed, else the store's own client. */
export function networkTarget(fallback: KybernClient | null, fallbackMachine?: MachineId): NetworkTarget | null {
  if (routing) return routing.network();
  return fallback ? { client: fallback, ...(fallbackMachine ? { machineId: fallbackMachine } : {}) } : null;
}

/** `machine: "all"` once there is more than one machine; older daemons ignore it and answer for themselves. */
export function listParams(): { machine?: string } {
  return routing?.multiple() ? { machine: MACHINE_ALL } : {};
}

/** The machine that holds an item, when known. */
export function ownerOf(kind: FederatedKind, id: string | null | undefined): MachineId | undefined {
  return id ? owners[kind].get(id) : undefined;
}

export function setOwner(kind: FederatedKind, id: string, machineId: MachineId | undefined) {
  if (machineId) owners[kind].set(id, machineId);
}

/**
 * A list read answered by `answering`: remember who holds each item. Items in no section (an older
 * daemon, or a single machine) belong to the machine that answered.
 */
export function recordList(kind: FederatedKind, ids: readonly string[], federation: Federation | null | undefined, answering?: MachineId) {
  const seen = new Set<string>();
  for (const section of federation?.sections ?? []) {
    const machine = section.is_self ? (answering ?? section.machine_id) : section.machine_id;
    for (const id of section.ids) {
      owners[kind].set(id, machine);
      seen.add(id);
    }
  }
  for (const id of ids) if (!seen.has(id) && answering) owners[kind].set(id, answering);
}

/** True while the machine holding the item answers (or nothing says it is held elsewhere and something answers). */
export function writable(kind: FederatedKind, id: string | null | undefined, fallback: KybernClient | null): boolean {
  const owner = ownerOf(kind, id);
  const target = networkTarget(fallback);
  if (!target) return false;
  if (!owner || !routing || owner === target.machineId) return true;
  return routing.machine(owner) !== null;
}

/**
 * The client to write an item with: the machine that holds it, else the network's. Throws a sentence
 * that says what to do when that machine is away or nothing answers.
 */
export function writeClient(kind: FederatedKind, id: string | null | undefined, fallback: KybernClient | null, fallbackMachine?: MachineId): KybernClient {
  const target = networkTarget(fallback, fallbackMachine);
  const owner = ownerOf(kind, id);
  if (owner && routing && owner !== target?.machineId) {
    const client = routing.machine(owner);
    if (client) return client;
    throw new Error(`${routing.name(owner)} is offline. Its ${NOUN[kind]} are read-only until it is back.`);
  }
  if (!target) throw new Error("Connect to your computer to continue.");
  return target.client;
}

/**
 * The items to show after a read: the answer, plus the last copy of items whose machine is away now
 * (the answering machine could not include them), so they stay visible, read-only.
 */
export function keepAway<T extends { id: string }>(kind: FederatedKind, fresh: readonly T[], previous: readonly T[], answering?: MachineId): T[] {
  if (!routing) return [...fresh];
  const ids = new Set(fresh.map((item) => item.id));
  const away = previous.filter((item) => {
    if (ids.has(item.id)) return false;
    const owner = ownerOf(kind, item.id);
    return !!owner && owner !== answering && routing!.machine(owner) === null;
  });
  return away.length ? [...fresh, ...away] : [...fresh];
}

/** The computer the phone is at changed: who holds what is read again. */
export function resetOwners(kind?: FederatedKind) {
  if (kind) owners[kind].clear();
  else {
    owners.notes.clear();
    owners.tasks.clear();
  }
}
