// "Add to another machine", for clients (ADE-86 provisioning). Plain functions: which machines a project can go to,
// which machine sends it, how paths read on the target, and the words of the sheet, the agent card and the transcript.
// The daemons do the work (`projects.provision_plan`, `projects.provision`, called on the SOURCE machine's connection).
import { sameForkProject, type ForkProjectShape } from "./forkMachine.ts";
import {
  PROJECT_PROVISION_TOOL,
  type ApprovalDecision,
  type ApprovalRequest,
  type EnvFileCandidate,
  type MachineId,
  type PathCheck,
  type ProvisionCardInput,
  type ProvisionPlan,
  type ProvisionStatus,
} from "./types.ts";

export const PROVISION_COPY = {
  menu: "Add to another machine…",
  sheetTitle: (project: string) => `Add ${project} to another machine`,
  sheetDescription: (target: string, source: string) => `${target} clones it with its own git sign-in, or ${source} sends it. Env files travel encrypted.`,
  machine: "Machine",
  from: "From",
  folder: "Folder",
  choose: "Choose…",
  envFiles: "Env files",
  envHint: "Copied as they are, encrypted on the way. Kybern never shows what is in them.",
  noEnvFiles: "No git-ignored env files in this project.",
  add: (machine: string) => `Add to ${machine}`,
  adding: (machine: string) => `Adding to ${machine}…`,
  done: "Done",
  cardTitle: (machine: string, project: string) => `${machine} doesn’t have ${project} yet`,
  cardThen: (then: string, machine: string) =>
    then === "delegate"
      ? `Add it there, and the agent starts on ${machine} once it is ready.`
      : then === "fork"
        ? `Add it there, and the fork goes on once it is ready.`
        : then === "move"
          ? `Add it there, and the thread moves once it is ready.`
          : `The agent asks to add it there.`,
  decline: "Cancel",
};

/** Partial group copy is shared by the card, manual sheet and fork sheet. */
export function partialGroupDetail(plan: Pick<ProvisionPlan, "members" | "project_name" | "target">): string | null {
  const members = plan.members ?? [];
  const present = members.filter((member) => member.present).length;
  return present > 0 && present < members.length ? `${plan.target.name} has ${present} of ${members.length} repos of ${plan.project_name}` : null;
}

export function provisionAddLabel(plan: ProvisionPlan): string {
  const missing = (plan.members ?? []).filter((member) => !member.present).length;
  return partialGroupDetail(plan) ? `Add the ${missing} missing` : PROVISION_COPY.add(plan.target.name);
}

/** The card's input, when this approval is the provisioning card. */
export function provisionCardInput(approval: Pick<ApprovalRequest, "tool_name" | "input">): ProvisionCardInput | null {
  if (approval.tool_name !== PROJECT_PROVISION_TOOL) return null;
  const input = approval.input as unknown as ProvisionCardInput | null;
  return input && typeof input === "object" && input.plan && typeof input.plan.project_name === "string" ? input : null;
}

/** `D:\code\kybern` or `/home/me/projects/kybern`: Windows paths have a drive letter or backslashes. */
export function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

const separatorOf = (path: string, os?: string) => (os === "windows" || isWindowsPath(path) ? "\\" : "/");

/** A path as the target's user reads it: its home becomes `~` (POSIX targets only; Windows keeps the drive). */
export function displayPath(path: string, home?: string | null, os?: string): string {
  if (!path) return "";
  if (!home || os === "windows" || isWindowsPath(path)) return path;
  const base = home.replace(/\/+$/, "");
  if (path === base) return "~";
  return path.startsWith(`${base}/`) ? `~${path.slice(base.length)}` : path;
}

/** The inverse of [`displayPath`]: `~/x` becomes the absolute path on the target, which is what it expects. Anything else,
 *  and `~` where the target has no home to put in, comes back as typed. */
export function expandPath(path: string, home?: string | null, os?: string): string {
  const typed = path.trim();
  if (!home || !typed.startsWith("~")) return typed;
  const rest = typed.slice(1);
  if (rest !== "" && !rest.startsWith("/") && !rest.startsWith("\\")) return typed;
  const sep = separatorOf(home, os);
  const tail = rest.replace(/^[\\/]+/, "");
  const base = home.replace(/[\\/]+$/, "");
  return tail ? `${base}${sep}${sep === "\\" ? tail.replace(/\//g, "\\") : tail}` : base;
}

/** `parent` + `name` with the target's separator. */
export function joinPath(parent: string, name: string, os?: string): string {
  const sep = separatorOf(parent, os);
  return `${parent.replace(/[\\/]+$/, "")}${sep}${name}`;
}

/** The last part of a path, on either kind of machine. */
export function baseName(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
}

/** Whether the sheet may go ahead with this folder. */
export function pathAccepted(check: PathCheck | null | undefined): boolean {
  return !check || check.state === "free" || check.state === "same_repo" || check.state === "unknown";
}

/** The folder the sheet starts with: the checked one when it is usable, else the proposed one, with the target's home as `~`. */
export function defaultPath(plan: Pick<ProvisionPlan, "suggested_path" | "path_check"> & Partial<Pick<ProvisionPlan, "target_home" | "target">>): string {
  const checked = plan.path_check;
  const path = checked && checked.path && pathAccepted(checked) && checked.state !== "unknown" ? checked.path : plan.suggested_path ?? checked?.path ?? "";
  return displayPath(path, plan.target_home, plan.target?.os);
}

/** The env files ticked by default. */
export function defaultEnvFiles(files: readonly EnvFileCandidate[]): string[] {
  return files.filter((file) => file.selected).map((file) => file.path);
}

/** "812 B", "4.2 KB". */
export function formatSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(bytes < 10_000 ? 1 : 0)} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
}

/** The card's answer. */
export function provisionAnswer(path: string, envFiles: readonly string[]): ApprovalDecision {
  return { decision: "submit", response: { path, env_files: [...envFiles] } };
}

/** One machine the manual sheet lists. */
export interface ProvisionTarget {
  machineId: MachineId;
  machineName: string;
  online: boolean;
  /** It already has the project: listed but not choosable. */
  has: boolean;
}

/** The machines a project can be added to, from the members and the machines that have it: everyone but the source,
 *  those without it first (online before offline), those that have it last. */
export function provisionTargets(
  members: readonly { machineId: MachineId; machineName: string; online: boolean; paused?: boolean; member?: boolean }[],
  having: ReadonlySet<MachineId>,
  source: MachineId,
): ProvisionTarget[] {
  return members
    .filter((member) => member.machineId !== source && member.member !== false && !member.paused)
    .map((member) => ({ machineId: member.machineId, machineName: member.machineName, online: member.online, has: having.has(member.machineId) }))
    .sort((a, b) => Number(a.has) - Number(b.has) || Number(b.online) - Number(a.online) || a.machineName.localeCompare(b.machineName));
}

/** The machine that sends a project: the one asked for when it has the project and is online, else an online one that has it. */
export function provisionSource(
  instances: readonly { machineId: MachineId; online: boolean }[],
  preferred?: MachineId | null,
): MachineId | null {
  const asked = instances.find((instance) => instance.machineId === preferred && instance.online);
  return asked?.machineId ?? instances.find((instance) => instance.online)?.machineId ?? null;
}

/** The second line of a machine tile in the sheet. */
export function targetDetail(target: ProvisionTarget, project: string): string {
  if (target.has) return `Already has ${project}`;
  return target.online ? "Online" : "Offline · sends when it returns";
}

/** The fork / Continue on tile line for a machine that will get the project first. */
export function notYetDetail(machine: string, path: string | null | undefined): string {
  return path ? `Not on ${machine} yet · will be added to ${path}` : `Not on ${machine} yet · it will be added first`;
}

/** The progress line under the sheet's bar, or the result line. */
export function provisionStatusText(status: Pick<ProvisionStatus, "phase" | "detail" | "error" | "target_name" | "bytes_sent" | "bytes_total" | "result">): string {
  switch (status.phase) {
    case "done": {
      const written = status.result?.env_written.length ?? 0;
      const files = written === 0 ? "" : written === 1 ? " · 1 env file copied" : ` · ${written} env files copied`;
      return `Added to ${status.target_name}${files}`;
    }
    case "failed":
      return status.error ?? status.detail ?? `Unable to add it to ${status.target_name}. Retry it from Settings → Machines.`;
    case "cancelled":
      return "Cancelled";
    case "sending": {
      const total = status.bytes_total ?? 0;
      const sent = status.bytes_sent ?? 0;
      const base = status.detail ?? `Sending to ${status.target_name}`;
      return total > 0 ? `${base} · ${formatSize(sent)} of ${formatSize(total)}` : base;
    }
    default:
      return status.detail ?? `Waiting for ${status.target_name}`;
  }
}

/** 0…1 for the progress bar, or null for an indeterminate one. */
export function provisionFraction(status: Pick<ProvisionStatus, "phase" | "bytes_sent" | "bytes_total">): number | null {
  if (status.phase === "done") return 1;
  if (status.phase === "sending" && status.bytes_total) return Math.min(1, (status.bytes_sent ?? 0) / status.bytes_total);
  return null;
}

export const provisionSettled = (status: Pick<ProvisionStatus, "phase">) =>
  status.phase === "done" || status.phase === "failed" || status.phase === "cancelled";

/** The transcript line a resolved (or waiting) card leaves. */
export function provisionRecordText(input: ProvisionCardInput, decision: ApprovalDecision | null): string {
  const { project_name: project, target } = input.plan;
  if (!decision) return `Waiting to add ${project} to ${target.name}`;
  if (decision.decision === "submit") {
    const path = (decision.response as { path?: unknown } | undefined)?.path;
    return typeof path === "string" && path ? `Adding ${project} to ${target.name} · ${displayPath(path, input.plan.target_home, target.os)}` : `Adding ${project} to ${target.name}`;
  }
  return `Did not add ${project} to ${target.name}`;
}

/** A group is ready only when every registered repository exists, with the same membership as the source. */
export function completeProvisionProject(source: ForkProjectShape | undefined, candidate: ForkProjectShape | undefined): boolean {
  if (!candidate) return false;
  if (source !== candidate && !sameForkProject(source, candidate)) return false;
  if (candidate.kind !== "group") return true;
  const members = candidate.members ?? [];
  return members.length > 0 && members.every((member) => member.status === "ok")
    && (!source?.members || members.length === source.members.length);
}
