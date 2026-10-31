// Where a new thread runs (machine network design §6.1, decision Q35). Pure and shared by the GPUIX and mobile composers:
// the picker's rows, the default machine, and the payload a send to an away machine queues in the outbox.
//
// A logical project is every machine's checkout of one repository (`machineMerge.ts`). The picker lists each machine in the
// network: those with a checkout can be chosen, online or not (an offline one queues the send), and those without one are
// offered setup on desktop before they can become the send target. A free chat has no project, so every machine counts as having it.

import { completeProvisionProject } from "./provision.ts";
import type { LogicalProject, ProjectInstance } from "./machineMerge.ts";
import type { MachineSummary } from "./machines.ts";
import type { MachineId, OutboxOp, Project, ProjectId, ThreadsCreateParams } from "./types.ts";

/** The key a free chat's last machine is remembered under (it has no project). */
export const FREE_CHAT_MACHINE_KEY = "free";

export type MachineChoiceState = "online" | "offline" | "no-checkout";

/** One row of the picker. */
export interface MachineChoice {
  machineId: MachineId;
  name: string;
  isLocal: boolean;
  state: MachineChoiceState;
  /** The machine's own project id for this repository; unset for a free chat or a machine without a checkout. */
  projectId?: ProjectId;
  /** That machine's checkout (its path, worktree default, accounts), for the lists and the create. */
  project?: Project;
  /** Free to choose: it has a checkout (a paused or offline machine queues the send). */
  selectable: boolean;
  /** The row's second line. */
  detail: string;
}

/** Whether a machine can take a send right now. `relaying` and `needs-update` still answer calls. */
export function machineReachable(status: MachineSummary["status"]): boolean {
  return status === "online" || status === "relaying" || status === "needs-update";
}

export interface ChoicesInput {
  machines: readonly Pick<MachineSummary, "machineId" | "name" | "status" | "isLocal">[];
  /** The logical project the thread starts in; `null` for a free chat. */
  project: Pick<LogicalProject, "instances"> | null;
  sourceProject?: Project;
}

/** The picker's rows in machine order (the machine you are at first, the app's own order after). */
export function machineChoices({ machines, project, sourceProject = project?.instances[0]?.project }: ChoicesInput): MachineChoice[] {
  const byMachine = new Map<MachineId, ProjectInstance>((project?.instances ?? []).map((instance) => [instance.machineId, instance]));
  const rows = machines.map((machine): MachineChoice => {
    const reachable = machineReachable(machine.status);
    const instance = byMachine.get(machine.machineId);
    if (project && (!instance || !completeProvisionProject(sourceProject, instance.project))) {
      return { machineId: machine.machineId, name: machine.name, isLocal: machine.isLocal, state: "no-checkout", selectable: false, detail: instance ? "Missing repositories · add to this machine…" : "No checkout · add to this machine…" };
    }
    return {
      machineId: machine.machineId,
      name: machine.name,
      isLocal: machine.isLocal,
      state: reachable ? "online" : "offline",
      ...(instance ? { projectId: instance.project.id, project: instance.project } : {}),
      selectable: true,
      detail: reachable ? (machine.status === "needs-update" ? "Online · needs an update" : "Online") : "Offline · sends when it returns",
    };
  });
  return rows.sort((a, b) => Number(b.isLocal) - Number(a.isLocal));
}

/**
 * Projects show the chip whenever several machines are known, including those that need setup.
 * Free chats retain their existing rule: more than one machine online.
 */
export function showMachinePicker(choices: readonly MachineChoice[], project: unknown | null): boolean {
  const usable = choices.filter((choice) => choice.selectable);
  if (project) return choices.length > 1;
  return usable.filter((choice) => choice.state === "online").length > 1;
}

export interface DefaultInput {
  choices: readonly MachineChoice[];
  /** The machine this project last started a thread on, if any. */
  lastUsed?: MachineId | null;
}

/**
 * Q35: the last machine used for this project, else the machine you are at (on the phone, the paired member), else the first
 * online one. A remembered machine that no longer has the project, or is gone from the network, is skipped.
 */
export function defaultMachine({ choices, lastUsed }: DefaultInput): MachineId | undefined {
  const usable = choices.filter((choice) => choice.selectable);
  if (lastUsed) {
    const remembered = usable.find((choice) => choice.machineId === lastUsed);
    if (remembered) return remembered.machineId;
  }
  return (usable.find((choice) => choice.isLocal) ?? usable.find((choice) => choice.state === "online") ?? usable[0])?.machineId;
}

/** The key a project's last machine is remembered under: the logical project's key, or the free chat's. */
export const machineMemoryKey = (project: Pick<LogicalProject, "key"> | null | undefined): string => project?.key ?? FREE_CHAT_MACHINE_KEY;

/**
 * Resolve the machine a draft sends to: the draft's own pick when it is still selectable, else the default. `picked` is the
 * draft's choice and `remembered` the last machine used for the project.
 */
export function resolveMachine(choices: readonly MachineChoice[], picked: MachineId | null | undefined, remembered: MachineId | null | undefined): MachineChoice | undefined {
  const id = (picked && choices.find((choice) => choice.machineId === picked && choice.selectable)?.machineId) ?? defaultMachine({ choices, lastUsed: remembered });
  return choices.find((choice) => choice.machineId === id);
}

/** The outbox operation for a new thread an away machine will make: the composer's `threads.create` parameters, with ids fixed now. */
export function queuedCreate(params: ThreadsCreateParams & { thread_id: string }, operationId?: string): OutboxOp {
  return { kind: "thread_create", payload: params, ...(operationId ? { operation_id: operationId } : {}) };
}
