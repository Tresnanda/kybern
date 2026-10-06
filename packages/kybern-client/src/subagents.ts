import type { RuntimeTaskStatus, SubagentInfo } from "./types.ts";

/** A read-only child thread that mirrors a provider-native subagent. */
export function isSubagentThread(thread: { subagent?: SubagentInfo | null } | null | undefined): boolean {
  return !!thread?.subagent;
}

/** Threads a user manages themselves: subagent threads are reached from their parent, never listed. */
export function withoutSubagents<T extends { subagent?: SubagentInfo | null }>(threads: readonly T[]): T[] {
  return threads.some(isSubagentThread) ? threads.filter((thread) => !isSubagentThread(thread)) : (threads as T[]);
}

export type SubagentPhase = "working" | "done" | "failed" | "stopped";

/** Collapse the provider task states into the four a subagent row shows. */
export function subagentPhase(status: RuntimeTaskStatus): SubagentPhase {
  switch (status) {
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "stopped":
    case "interrupted":
      return "stopped";
    default:
      return "working";
  }
}
