// Fork a thread to another machine, for clients (ADE-86 M3; design §7.1). Plain functions: who can take a fork,
// what the sheet asks, how the three transcript notices read and how `kybern://thread/<machine>/<thread>` links
// resolve. The daemon does the work (`threads.fork_note`, `threads.fork_to_machine`); the target gets a new
// thread whose `origin.kind` is `fork`, and the source gets a notice when the fork arrives, waits or fails.
import type { JsonValue, MachineId, Origin, PermissionMode, ThreadId, ThreadsForkToMachineParams } from "./types.ts";

// ---- links ----

const MACHINE = "[A-Za-z0-9][A-Za-z0-9_.-]*";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const THREAD_HREF = new RegExp(`^kybern://thread/(?:(${MACHINE})/)?(${UUID})/?$`, "i");

export interface ThreadLink {
  /** The machine that holds the thread; absent in a link written without one (the machine the reader is on). */
  machineId?: MachineId;
  threadId: ThreadId;
}

/** `kybern://thread/<machine>/<thread>`: the link the new thread keeps back to its source. */
export function threadLinkHref(machineId: MachineId, threadId: ThreadId): string {
  return `kybern://thread/${machineId}/${threadId}`;
}

/** The thread a `kybern://thread/…` href names, with or without its machine, or null. Ids are UUIDs; nothing else passes. */
export function parseThreadLink(href: string): ThreadLink | null {
  let value = href.trim();
  if (value.startsWith("<") && value.endsWith(">")) value = value.slice(1, -1);
  const match = THREAD_HREF.exec(value);
  if (!match) return null;
  return { ...(match[1] ? { machineId: match[1] } : {}), threadId: match[2]!.toLowerCase() };
}

// ---- notices ----

export type ForkNoticeKind = "fork" | "fork_queued" | "fork_failed";

/** The `data` of a `provider_notice` the daemon wrote about a fork, in the words the transcript row needs. */
export interface ForkNotice {
  kind: ForkNoticeKind;
  machineId: MachineId;
  machineName: string;
  /** The new thread, once the fork arrived: the row offers "Open". */
  threadId?: ThreadId;
  branch?: string;
}

const isRecord = (value: unknown): value is Record<string, JsonValue> => typeof value === "object" && value !== null && !Array.isArray(value);

export function forkNotice(data: JsonValue | null | undefined): ForkNotice | null {
  if (!isRecord(data)) return null;
  const kind = data.kind;
  if (kind !== "fork" && kind !== "fork_queued" && kind !== "fork_failed") return null;
  const machineId = typeof data.machine_id === "string" ? data.machine_id : "";
  if (!machineId) return null;
  const threadId = typeof data.thread_id === "string" && data.thread_id ? data.thread_id : undefined;
  return {
    kind,
    machineId,
    machineName: typeof data.machine_name === "string" && data.machine_name ? data.machine_name : "another machine",
    // "Open" needs a thread: a fork that did not arrive has none.
    ...(kind === "fork" && threadId ? { threadId } : {}),
    ...(typeof data.branch === "string" ? { branch: data.branch } : {}),
  };
}

/** The label of the "Open" link on a fork notice, or null when there is nothing to open. */
export function forkNoticeAction(notice: ForkNotice): { label: string; href: string } | null {
  return notice.kind === "fork" && notice.threadId ? { label: "Open", href: threadLinkHref(notice.machineId, notice.threadId) } : null;
}

/** The row's words: the daemon writes "Forked to satyamas · open", and the row draws its own "Open" beside them. */
export function forkNoticeText(notice: ForkNotice, text: string): string {
  return forkNoticeAction(notice) ? text.replace(/\s*·\s*open\s*$/i, "") : text;
}

// ---- where a thread came from ----

/** "From satyamas": a thread another machine started by a fork or a delegation. Null for work started here. */
export function originLabel(thread: { origin?: Pick<Origin, "machine_name" | "kind"> | null } | null | undefined): string | null {
  const origin = thread?.origin;
  if (!origin || !origin.machine_name) return null;
  switch (origin.kind.kind) {
    case "fork":
    case "delegation":
    case "move":
      return `From ${origin.machine_name}`;
    default:
      return null;
  }
}

// ---- who can take a fork ----

export interface ForkInstance {
  machineId: MachineId;
  machineName: string;
  /** The machine's project that matches the thread's repository. */
  projectId: string;
  /** Reachable now. A fork to an offline machine waits in the outbox, so it is still offered. */
  online: boolean;
  paused?: boolean;
}

/**
 * The machines a thread can be forked to: every other machine that has the thread's project. Offline ones stay
 * in the list (the fork waits in the outbox and arrives when the machine returns); a paused one is left out.
 */
export function forkTargets(
  instances: readonly { machineId: MachineId; machineName: string; projectId: string; online: boolean; paused?: boolean }[],
  thread: { machineId: MachineId },
): ForkInstance[] {
  return instances
    .filter((instance) => instance.machineId !== thread.machineId && !instance.paused)
    .map((instance) => ({ ...instance }))
    .sort((a, b) => Number(b.online) - Number(a.online) || a.machineName.localeCompare(b.machineName));
}

export interface ForkSheetState {
  machine: MachineId;
  note: string;
  pushOrigin: boolean;
}

/** What the sheet starts with: the first target, the generated note, and no push to origin (the repository may be public). */
export function forkSheetDefaults(targets: readonly ForkInstance[], note: string): ForkSheetState {
  return { machine: targets[0]?.machineId ?? "", note, pushOrigin: false };
}

/** The `threads.fork_to_machine` call for the sheet. An unedited note is sent as the generated one. */
export function forkParams(
  threadId: ThreadId,
  target: Pick<ForkInstance, "machineId" | "projectId">,
  state: Pick<ForkSheetState, "note" | "pushOrigin">,
  generated: string,
  permissionMode?: PermissionMode | null,
): ThreadsForkToMachineParams {
  const note = state.note.trim();
  return {
    thread_id: threadId,
    machine: target.machineId,
    project: target.projectId,
    push_origin: state.pushOrigin,
    // An empty or unchanged note lets the daemon build its own.
    ...(note && note !== generated.trim() ? { handoff_note: note } : {}),
    ...(permissionMode ? { permission_mode: permissionMode } : {}),
  };
}

/** What the sheet says once the fork is queued: it travels now, or waits for the machine. */
export function forkQueuedText(targetName: string, online: boolean): string {
  return online ? `Forking to ${targetName}…` : `Forking to ${targetName} when it is back online.`;
}
