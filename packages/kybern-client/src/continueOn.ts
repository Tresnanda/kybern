// Continue a thread on another machine, for clients (ADE-86 M3 / F2; design §7.2). Plain functions: what the read-only
// banner says, what the sheet sends and how the move reads while it waits. The daemon does the work
// (`threads.move_to_machine`, `threads.move_abandon`); the thread's `moved` record is the truth about the lease.
import { threadLinkHref } from "./forkMachine.ts";
import type { ForkSheetState } from "./forkMachine.ts";
import type { MachineId, OutboxItem, PermissionMode, ProviderKind, Thread, ThreadId, ThreadsMoveToMachineParams } from "./types.ts";

export interface MoveBanner {
  /** `departing` holds the lease (the thread takes no messages); `departed` is final. */
  state: "departing" | "departed";
  machineId: MachineId;
  machineName: string;
  /** Plain words for the strip above the composer. */
  text: string;
  /** "Open": the thread that continues the work. Only once the target confirmed it. */
  open?: { label: string; href: string };
  /** The commit went out and no answer came back; Keep here asks the target and gives up. */
  uncertain: boolean;
  /** The lease holds the composer: nothing is sent until the move finishes or is stopped. */
  composerLocked: true;
}

/** The banner a moved or moving thread shows, or null for an ordinary thread. */
export function moveBanner(thread: Pick<Thread, "moved"> | null | undefined): MoveBanner | null {
  const moved = thread?.moved;
  if (!moved || moved.state === "arrived") return null;
  const name = moved.peer_name || "another machine";
  const base = { machineId: moved.peer, machineName: name, uncertain: moved.uncertain === true, composerLocked: true as const };
  if (moved.state === "departed") {
    return {
      ...base,
      state: "departed",
      text: `This thread continues on ${name}.`,
      ...(moved.peer_thread_id ? { open: { label: "Open", href: threadLinkHref(moved.peer, moved.peer_thread_id) } } : {}),
    };
  }
  return {
    ...base,
    state: "departing",
    text: moved.uncertain ? `Couldn't confirm the move to ${name}. It may already be there.` : `Moving to ${name}…`,
  };
}

/** Does the thread take messages? A moving or moved thread does not (the daemon refuses them too). */
export function threadTakesMessages(thread: Pick<Thread, "moved"> | null | undefined): boolean {
  return !moveBanner(thread);
}

/** The `threads.move_to_machine` call for the sheet; an unedited note is sent as the generated one. */
export function moveParams(
  threadId: ThreadId,
  target: { machineId: MachineId; projectId: string },
  state: Pick<ForkSheetState, "note">,
  generated: string,
  permissionMode?: PermissionMode | null,
  provider?: ProviderKind | null,
  /** The model and effort picked in the sheet; null ones leave the choice to the target. */
  choice?: { model: string | null; effort: string | null } | null,
): ThreadsMoveToMachineParams {
  const note = state.note.trim();
  return {
    thread_id: threadId,
    machine: target.machineId,
    project: target.projectId,
    ...(note && note !== generated.trim() ? { handoff_note: note } : {}),
    ...(permissionMode ? { permission_mode: permissionMode } : {}),
    ...(provider ? { provider } : {}),
    ...(choice?.model ? { model: choice.model } : {}),
    ...(choice?.model && choice.effort ? { effort: choice.effort } : {}),
  };
}

/** What the sheet says once the move is queued: it goes when the turn ends and the machine is up. */
export function moveQueuedText(targetName: string, online: boolean): string {
  return online ? `Moving to ${targetName} when this turn ends…` : `Moving to ${targetName} when it is back online.`;
}

/** The outbox item of a move that has not been delivered, for "Waiting for satyamas" in the thread. */
export function waitingMove(items: readonly OutboxItem[], threadId: ThreadId): OutboxItem | null {
  return (
    items.find((item) => {
      if (item.kind !== "move" || item.state === "delivered" || item.state === "cancelled") return false;
      const payload = item.payload as { source_thread_id?: string } | null;
      return payload?.source_thread_id === threadId;
    }) ?? null
  );
}

/** "Earlier on Mac · 12 messages": the collapsed history block's label. */
export function historyLabel(machineName: string, items: readonly { role: string }[], omitted = 0): string {
  const messages = items.filter((item) => item.role === "user" || item.role === "assistant").length;
  const more = omitted > 0 ? ` (+${omitted} older)` : "";
  return `Earlier on ${machineName} · ${messages} ${messages === 1 ? "message" : "messages"}${more}`;
}
