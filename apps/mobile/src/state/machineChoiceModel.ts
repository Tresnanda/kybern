// Which machine a machine-scoped screen (Settings, Add project, Import sessions) works on (pure; tested in
// `tests/machine-choice.test.mjs`). The pick wins while that machine answers; otherwise the computer the phone is at
// while it answers; otherwise the nearest live machine, so the screen keeps working while the paired computer is
// away (#245). With nothing live it stays on the computer the phone is at, which then shows as offline.
import type { MachineId } from "../../../../packages/kybern-client/src/types";

export interface ChoiceMachine {
  machineId: MachineId;
  name: string;
  status: string;
}

export interface ResolvedChoice {
  machineId: MachineId;
  name: string;
  /** It is the computer the phone is at. */
  primary: boolean;
  /** Requests reach it now. */
  live: boolean;
}

const LIVE = new Set(["online", "relaying", "needs-update"]);
export const isLiveStatus = (status: string) => LIVE.has(status);

export function resolveChoice(args: {
  picked: MachineId | null | undefined;
  machines: readonly ChoiceMachine[];
  primaryId: MachineId | undefined;
  /** The phone's own connection to the computer it is at is open. */
  primaryOpen: boolean;
}): ResolvedChoice | undefined {
  const { picked, machines, primaryId, primaryOpen } = args;
  const of = (m: ChoiceMachine, live: boolean): ResolvedChoice => ({ machineId: m.machineId, name: m.name, primary: m.machineId === primaryId, live });
  const primary = machines.find((m) => m.machineId === primaryId);
  const liveOf = (m: ChoiceMachine) => (m.machineId === primaryId ? primaryOpen : LIVE.has(m.status));
  const chosen = picked ? machines.find((m) => m.machineId === picked) : undefined;
  if (chosen && liveOf(chosen)) return of(chosen, true);
  if (primary && primaryOpen) return of(primary, true);
  const member = machines.find((m) => m.machineId !== primaryId && LIVE.has(m.status));
  if (member) return of(member, true);
  return primary ? of(primary, false) : undefined;
}
