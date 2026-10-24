// One status vocabulary for runtime tasks (processes, provider subagents),
// delegated child threads, threads and tasks. Every surface shows the same
// phase glyph, tone and sentence-case word for the same state.
import type {
  DelegationStatus,
  RuntimeTaskStatus,
  TaskStatus,
  Thread,
} from "./protocol";

/** What a row's glyph draws. */
export type StatusPhase =
  | "queued"
  | "idle"
  | "working"
  | "waiting"
  | "done"
  | "failed"
  | "stopped";

export type StatusTone = "accent" | "warning" | "positive" | "negative" | "secondary" | "muted";

export type StatusInfo = {
  phase: StatusPhase;
  /** Sentence case, ready for a row: "Running", "Needs approval". */
  word: string;
  tone: StatusTone;
  /** Still going: animate the glyph, count it as running. */
  active: boolean;
};

const TONE: Record<StatusPhase, StatusTone> = {
  queued: "muted",
  idle: "muted",
  working: "accent",
  waiting: "warning",
  done: "positive",
  failed: "negative",
  stopped: "secondary",
};
const info = (phase: StatusPhase, word: string): StatusInfo => ({
  phase,
  word,
  tone: TONE[phase],
  active: phase === "working" || phase === "waiting" || phase === "queued",
});

/** A process or provider subagent task. */
export function runtimeStatus(status: RuntimeTaskStatus): StatusInfo {
  switch (status) {
    case "pending":
      return info("queued", "Queued");
    case "running":
      return info("working", "Running");
    case "waiting":
      return info("waiting", "Waiting");
    case "stopping":
      return info("working", "Stopping");
    case "completed":
      return info("done", "Finished");
    case "failed":
      return info("failed", "Failed");
    case "stopped":
      return info("stopped", "Stopped");
    case "interrupted":
      return info("stopped", "Interrupted");
  }
}

/** A delegated child thread's outcome. */
export function delegationStatus(status: DelegationStatus): StatusInfo {
  switch (status) {
    case "running":
      return info("working", "Running");
    case "completed":
      return info("done", "Completed");
    case "failed":
      return info("failed", "Failed");
    case "cancelled":
      return info("stopped", "Canceled");
    case "interrupted":
      return info("stopped", "Interrupted");
  }
}

/** A thread's own status. */
export function threadStatus(status: Thread["status"]): StatusInfo {
  switch (status) {
    case "running":
      return info("working", "Running");
    case "awaiting-approval":
      return info("waiting", "Needs approval");
    case "failed":
      return info("failed", "Failed");
    case "archived":
      return info("idle", "Archived");
    default:
      return info("idle", "Idle");
  }
}

/** A child row: delegation outcome, subagent task state, else the thread's status. */
export function childStatus(
  thread: Pick<Thread, "status" | "delegation" | "subagent">,
): StatusInfo {
  if (thread.delegation) return delegationStatus(thread.delegation.status);
  if (thread.subagent) return runtimeStatus(thread.subagent.status);
  return threadStatus(thread.status);
}

/** A task. Words match the Tasks screens. */
export function taskStatus(status: TaskStatus): StatusInfo {
  switch (status) {
    case "inbox":
      return info("queued", "Inbox");
    case "todo":
      return info("idle", "To do");
    case "running":
      return info("working", "Running");
    case "needs_review":
      return info("waiting", "Needs review");
    case "done":
      return info("done", "Done");
    case "canceled":
      return info("stopped", "Canceled");
  }
}
