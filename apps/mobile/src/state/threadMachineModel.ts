// Who can take a fork or a move of a thread, on the phone (ADE-99 §2.2, §2.3). Pure: it reads the merged view, so the same rows
// feed the sheet, the menu and the tests. Machines with the project can be chosen; the others are listed disabled with
// "No checkout on <machine>" and can be set up from the row.
import { forkTargets, type ForkInstance } from "../../../../packages/kybern-client/src/forkMachine";
import { machineChoiceDetail } from "../../../../packages/kybern-client/src/machineAgents";
import type { LogicalProject } from "../../../../packages/kybern-client/src/machineMerge";
import type { MachineSummary } from "../../../../packages/kybern-client/src/machines";
import { completeProvisionProject, provisionSource } from "../../../../packages/kybern-client/src/provision";
import { machineReachable } from "../../../../packages/kybern-client/src/machineTarget";
import type { MachineId, Project, ProjectId } from "../../../../packages/kybern-client/src/types";

export interface SheetTarget {
  machineId: MachineId;
  machineName: string;
  online: boolean;
  /** The target machine's project; empty while `missing`. */
  projectId: ProjectId;
  /** No checkout of the project there: shown disabled, with Set up project. */
  missing: boolean;
  detail: string;
}

export interface ThreadMachineModel {
  /** The machine that sends the thread, and the project it works in there. */
  sourceMachine: MachineId;
  sourceProject: Project;
  targets: SheetTarget[];
  /** An online machine that has the project: it sends the project to a machine that lacks it. */
  provisionFrom: { machineId: MachineId; projectId: ProjectId } | null;
}

export const noCheckoutText = (machine: string) => `No checkout on ${machine}`;

/**
 * `gate` says whether a target is new enough (spec §0: fork and move check the target). Paused machines are left out, as on
 * desktop; offline ones stay (the send waits for them). Null for a free chat, which has no project to carry over.
 */
export function threadMachineModel(input: {
  machines: readonly Pick<MachineSummary, "machineId" | "name" | "status">[];
  projects: readonly LogicalProject[];
  threadMachine: MachineId;
  projectId: ProjectId | undefined;
  gate: (machineId: MachineId) => boolean;
}): ThreadMachineModel | null {
  const { machines, projects, threadMachine, projectId, gate } = input;
  if (!projectId) return null;
  const logical = projects.find((item) => item.instances.some((i) => i.machineId === threadMachine && i.project.id === projectId));
  const source = logical?.instances.find((i) => i.machineId === threadMachine && i.project.id === projectId);
  if (!logical || !source) return null;
  const known = machines.filter((m) => m.machineId !== threadMachine && m.status !== "paused" && gate(m.machineId));
  const online = new Map(known.map((m) => [m.machineId, machineReachable(m.status)]));
  const instances: ForkInstance[] = logical.instances
    .filter((i) => online.has(i.machineId) && completeProvisionProject(source.project, i.project))
    .map((i) => ({ machineId: i.machineId, machineName: known.find((m) => m.machineId === i.machineId)!.name, projectId: i.project.id, online: online.get(i.machineId)!, project: i.project }));
  const having = forkTargets(instances, { machineId: threadMachine, project: source.project }).map(
    (item): SheetTarget => ({ machineId: item.machineId, machineName: item.machineName, online: item.online, projectId: item.projectId, missing: false, detail: machineChoiceDetail(item.online, null) }),
  );
  const haveIds = new Set(having.map((item) => item.machineId));
  const missing = known
    .filter((m) => !haveIds.has(m.machineId))
    .map((m): SheetTarget => ({ machineId: m.machineId, machineName: m.name, online: online.get(m.machineId)!, projectId: "", missing: true, detail: noCheckoutText(m.name) }))
    .sort((a, b) => Number(b.online) - Number(a.online) || a.machineName.localeCompare(b.machineName));
  const sender = provisionSource(
    logical.instances.map((i) => ({ machineId: i.machineId, online: i.machineId === threadMachine || machineReachable(machines.find((m) => m.machineId === i.machineId)?.status ?? "offline") })),
    threadMachine,
  );
  const senderInstance = logical.instances.find((i) => i.machineId === sender);
  return {
    sourceMachine: threadMachine,
    sourceProject: source.project,
    targets: [...having, ...missing],
    provisionFrom: senderInstance ? { machineId: senderInstance.machineId, projectId: senderInstance.project.id } : null,
  };
}

/** Whether the thread's menu offers fork and continue: two or more machines and at least one other that could take it. */
export const offersMachineMoves = (model: ThreadMachineModel | null, machineCount: number): boolean => machineCount >= 2 && !!model && model.targets.length > 0;

/** The sentence under the thread title: "on satyamas" or "on satyamas · offline". Empty with one machine. */
export function threadMachineLine(machineCount: number, machine: Pick<MachineSummary, "name" | "status"> | undefined): string {
  if (machineCount < 2 || !machine) return "";
  return machineReachable(machine.status) ? `on ${machine.name}` : `on ${machine.name} · offline`;
}

// ---- the fork and continue sheet's words ----

export const FORK_COPY = {
  forkTitle: "Fork to another machine",
  moveTitle: "Continue on another machine",
  forkAction: "Fork thread",
  moveAction: "Continue there",
  forkHint: "Starts a copy there with a hand-off note. Both threads keep going.",
  moveHint: "Moves the thread and its uncommitted work. This one becomes read-only.",
  noteLabel: "Hand-off note",
  noteWriting: "Writing the hand-off note…",
  notePlaceholder: "What the other machine needs to pick this up",
  noteError: (reason: string) => `Unable to write the hand-off note. ${reason} Write one yourself, or send without it.`,
  none: "No other machine is in your network yet.",
} as const;
