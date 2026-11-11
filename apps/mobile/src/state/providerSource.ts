// Which machine's agent list a composer reads (pure, tested in `tests/composer-machine.test.mjs`). The hooks that use
// these rules are in `machineProviders.ts`.
import type { MachineSummary } from "../../../../packages/kybern-client/src/machines";
import type { MachineId } from "../../../../packages/kybern-client/src/types";

/** The machine a provider list is read from; undefined is the computer the phone is at while it answers. */
export type ProviderMachine = { machineId: MachineId; reachable: boolean };

/** Enough of `MachineTarget` to tell where Home's next thread runs. */
export interface ProviderTarget {
  chosen?: { machineId: MachineId };
  remote: boolean;
  reachable: boolean;
}

const LIVE = new Set(["online", "relaying", "needs-update"]);

/** Home's rule: another machine, or the computer the phone is at while it is away, lists its own agents. */
export function providerMachine(target: ProviderTarget): ProviderMachine | undefined {
  const chosen = target.remote || !target.reachable ? target.chosen : undefined;
  return chosen ? { machineId: chosen.machineId, reachable: target.reachable } : undefined;
}

/** An open thread lists its own machine's agents, unless that is the computer the phone is at and it answers. */
export function threadProviderMachine(connection: { machineId?: MachineId; remote: boolean; open: boolean }): ProviderMachine | undefined {
  return connection.machineId && (connection.remote || !connection.open)
    ? { machineId: connection.machineId, reachable: connection.open }
    : undefined;
}

/**
 * A machine with no known agent list (the computer the phone is at, away since before the app opened) borrows a live
 * member's, so agents and models can still be picked for a send that waits in the outbox. Undefined when the list is known.
 */
export function standInMachine(
  machines: readonly Pick<MachineSummary, "machineId" | "status">[],
  machineId: MachineId | undefined,
  known: boolean,
): MachineId | undefined {
  if (known) return undefined;
  return machines.find((m) => LIVE.has(m.status) && m.machineId !== machineId)?.machineId;
}
