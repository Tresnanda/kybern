// Who can take a fork or a move of a thread, on the phone (ADE-99 §2.2, §2.3). Pure: it reads the merged view, so the same rows
// feed the sheet, the menu and the tests. One row per machine: a machine with the project can be chosen; one without it reads
// "No checkout · Set up project" and leads into setting it up, or "No checkout" when it cannot be set up from here.
import { forkTargets, type ForkInstance } from "../../../../packages/kybern-client/src/forkMachine";
import { machineChoiceDetail } from "../../../../packages/kybern-client/src/machineAgents";
import type { LogicalProject } from "../../../../packages/kybern-client/src/machineMerge";
import type { MachineSummary } from "../../../../packages/kybern-client/src/machines";
import { completeProvisionProject, provisionSource } from "../../../../packages/kybern-client/src/provision";
import { machineReachable } from "../../../../packages/kybern-client/src/machineTarget";
import type { MachineChoice } from "../../../../packages/kybern-client/src/machineTarget";
import type { MachineId, Project, ProjectId } from "../../../../packages/kybern-client/src/types";

export interface SheetTarget {
  machineId: MachineId;
  machineName: string;
  online: boolean;
  /** The target machine's project; empty while `missing`. */
  projectId: ProjectId;
  /** No checkout of the project there: it cannot take the thread until the project is set up there. */
  missing: boolean;
  /** `missing`, and the project can be set up there from here (the row leads into Set up project). */
  canSetUp: boolean;
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

/** A machine's row says what it lacks; its name is already the title. */
export const MACHINE_ROW_COPY = {
  noCheckout: "No checkout",
  setUp: "No checkout · Set up project",
  offline: "No checkout · Offline",
  /** The machine the phone is paired with: the phone reaches the others through it. */
  paired: "Paired with this phone",
} as const;

/** The second line of a machine without the project. */
export function missingDetail(online: boolean, canSetUp: boolean): string {
  if (!online) return MACHINE_ROW_COPY.offline;
  return canSetUp ? MACHINE_ROW_COPY.setUp : MACHINE_ROW_COPY.noCheckout;
}

/** `detail` with "Paired with this phone" after it for the machine the phone is paired with. */
export const withPaired = (detail: string, paired: boolean): string => (paired ? (detail ? `${detail} · ${MACHINE_ROW_COPY.paired}` : MACHINE_ROW_COPY.paired) : detail);

/** One row of the new-thread machine menu: pick the machine, or set the project up there. */
export interface MachineMenuRow {
  machineId: MachineId;
  title: string;
  subtitle: string;
  checked: boolean;
  disabled: boolean;
  action: "pick" | "setup" | "none";
}

/**
 * The machine chip's menu (§2.3): one row per machine. A machine without the project leads into Set up project when
 * `sender` (an online machine with the project) and the gate allow it; otherwise it is disabled and says why.
 */
export function machineMenuRows(input: {
  choices: readonly MachineChoice[];
  chosen: MachineId | undefined;
  online: (machineId: MachineId) => boolean;
  /** Whether the project can be set up on this machine from here (a sender exists and both run 0.21.0+). */
  canSetUp: (machineId: MachineId) => boolean;
}): MachineMenuRow[] {
  return input.choices.map((choice) => {
    if (choice.state === "no-checkout") {
      const online = input.online(choice.machineId);
      const setUp = online && input.canSetUp(choice.machineId);
      return {
        machineId: choice.machineId,
        title: choice.name,
        subtitle: withPaired(missingDetail(online, setUp), choice.isLocal),
        checked: false,
        disabled: !setUp,
        action: setUp ? "setup" : "none",
      };
    }
    return {
      machineId: choice.machineId,
      title: choice.name,
      subtitle: withPaired(choice.detail, choice.isLocal),
      checked: choice.machineId === input.chosen,
      disabled: !choice.selectable,
      action: choice.selectable ? "pick" : "none",
    };
  });
}

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
    (item): SheetTarget => ({
      machineId: item.machineId,
      machineName: item.machineName,
      online: item.online,
      projectId: item.projectId,
      missing: false,
      canSetUp: false,
      detail: machineChoiceDetail(item.online, null),
    }),
  );
  const sender = provisionSource(
    logical.instances.map((i) => ({ machineId: i.machineId, online: i.machineId === threadMachine || machineReachable(machines.find((m) => m.machineId === i.machineId)?.status ?? "offline") })),
    threadMachine,
  );
  const senderInstance = logical.instances.find((i) => i.machineId === sender);
  const settable = !!senderInstance && gate(senderInstance.machineId);
  const haveIds = new Set(having.map((item) => item.machineId));
  const missing = known
    .filter((m) => !haveIds.has(m.machineId))
    .map((m): SheetTarget => {
      const up = online.get(m.machineId)!;
      return { machineId: m.machineId, machineName: m.name, online: up, projectId: "", missing: true, canSetUp: up && settable, detail: missingDetail(up, up && settable) };
    })
    .sort((a, b) => Number(b.online) - Number(a.online) || a.machineName.localeCompare(b.machineName));
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
