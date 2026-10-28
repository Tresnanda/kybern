// Saved computers as machine records (design §5.2 "Migration of environments.json",
// applied to the phone). A computer's machine id is its daemon's environment id; a
// computer saved before the phone knew it gets a `legacy:` stand-in that the set
// re-keys the first time the daemon answers.
import type { MachineRecord } from "../../../../packages/kybern-client/src/machines";
import type { Endpoint } from "../../../../packages/kybern-client/src/client";
import { normalizeDaemonUrl } from "../../../../packages/kybern-client/src/address";

/** What `runtime.ts` saves for one computer. */
export type SavedComputer = Endpoint & { id: string; name: string };

export const LEGACY_PREFIX = "legacy:";
/** A computer's machine id: its daemon's environment id, else a stand-in replaced the first time the daemon answers. */
export const legacyMachineId = (computer: Pick<SavedComputer, "id" | "environmentId">) =>
  computer.environmentId || `${LEGACY_PREFIX}${computer.id}`;
export const isLegacyMachineId = (machineId: string) => machineId.startsWith(LEGACY_PREFIX);

/** `ws://host:port/ws` as the machine set's `http://host:port` route. */
export function routeUrl(url: string): string {
  return url.replace(/^ws/, "http").replace(/\/ws\/?$/, "");
}

export function recordOfComputer(computer: SavedComputer): MachineRecord {
  return {
    machineId: legacyMachineId(computer),
    name: computer.name,
    routes: computer.url ? [{ kind: "direct_advertised", url: routeUrl(computer.url) }] : [],
    // A daemon the user paired by code is not in the network (design §4.3): its
    // connection is checked by the client's own environment id, not an identity document.
    member: false,
    legacyProfileId: computer.id,
  };
}

/** The saved computers, in the order the user saved them. */
export const recordsFromComputers = (computers: readonly SavedComputer[]): MachineRecord[] => computers.map(recordOfComputer);

/**
 * A record back as a computer the phone can open itself: it needs a direct address and a token.
 * A machine only reachable through a member has neither and is the set's to connect.
 */
export function computerOfRecord(record: MachineRecord, token: string | null | undefined): SavedComputer | undefined {
  const route = record.routes.find((r) => r.kind === "direct_advertised" && r.url);
  if (!route || !token) return undefined;
  let url: string;
  try {
    url = normalizeDaemonUrl(route.url);
  } catch {
    return undefined;
  }
  return {
    id: record.machineId,
    name: record.name,
    url,
    token,
    ...(isLegacyMachineId(record.machineId) ? {} : { environmentId: record.machineId }),
  };
}
