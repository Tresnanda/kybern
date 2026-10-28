// Saved computers (SecureStore `kybern.ink.environments`) as machine records
// (design §5.2 "Migration of environments.json", applied to the phone). Each
// computer keeps its environment id in `legacyProfileId`, which is how the hub
// finds its token.
//
// TODO(N7 part 2): persist the records (`kybern.ink.machines`) and move the
// device tokens to per-machine keys once pairing writes them; until then the
// records are derived from the saved computers on every start and nothing is
// written.
import type { MachineRecord } from "../../../../packages/kybern-client/src/machines";
import type { Endpoint } from "../../../../packages/kybern-client/src/client";

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
