import type {
  AgentResultItem,
  ContentPart,
  DelegationStatus,
  Thread,
  ThreadMessagePart,
  ThreadMessagePurpose,
  UserMessage,
} from "./protocol";

const PURPOSES: Record<ThreadMessagePurpose, string> = {
  task: "Task",
  message: "Message",
  question: "Question",
  reply: "Reply",
  warning: "Warning",
};

const DELEGATION: Record<DelegationStatus, string> = {
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
};

const THREAD: Record<Thread["status"], string> = {
  idle: "Idle",
  running: "Running",
  "awaiting-approval": "Needs approval",
  failed: "Failed",
  archived: "Archived",
};

export type OrchestrationPart = ThreadMessagePart | Extract<ContentPart, { type: "agent_results" }>;

export function isOrchestrationPart(part: ContentPart): part is OrchestrationPart {
  return part.type === "thread_message" || part.type === "agent_results";
}

export function hasOrchestrationParts(message: UserMessage) {
  return message.parts.some(isOrchestrationPart);
}

export const purposeLabel = (purpose: ThreadMessagePurpose) => PURPOSES[purpose] ?? "Message";

export const delegationStatusWord = (status: DelegationStatus) => DELEGATION[status] ?? "Unknown";

/** "Task · Reviewer": who sent it and why. Kybern itself sends with no thread. */
export function threadMessageHeading(part: ThreadMessagePart) {
  return `${purposeLabel(part.purpose)} · ${part.from_title.trim() || (part.from_thread_id ? "Another thread" : "Kybern")}`;
}

/** First non-empty line of a result or error, trimmed for a one-line row. */
export function firstLine(text: string | null | undefined, max = 140) {
  const line = (text ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The outcome line of one delegated agent: its result, else its error, else a status hint. */
export function resultSummary(item: AgentResultItem) {
  return (
    firstLine(item.result) ||
    firstLine(item.error) ||
    (item.status === "running" ? "Still working" : "No result text")
  );
}

/** Where its work landed: the kept branch for a worktree, else how many files it edited. */
export function resultLocation(item: AgentResultItem) {
  if (item.workspace === "worktree" && item.branch) return item.branch;
  const files = item.files_touched?.length ?? item.diffstat?.files ?? 0;
  return files > 0 ? `${files} ${files === 1 ? "file" : "files"} touched` : "";
}

/** Status word of a child row: delegation outcome, subagent task state, or the thread's own status. */
export function childStatusWord(thread: Thread) {
  if (thread.delegation) return delegationStatusWord(thread.delegation.status);
  if (thread.subagent) {
    const status = thread.subagent.status;
    return status.charAt(0).toUpperCase() + status.slice(1);
  }
  return THREAD[thread.status] ?? "Idle";
}

export function childIsRunning(thread: Thread) {
  if (thread.delegation) return thread.delegation.status === "running";
  if (thread.subagent) return ["pending", "running", "waiting", "stopping"].includes(thread.subagent.status);
  return thread.status === "running" || thread.status === "awaiting-approval";
}

/** Oldest first, so the list reads in the order the agents were started. */
export function sortChildren(threads: readonly Thread[]) {
  return [...threads].sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/** One line for a queued message made of agent messages or results; null for ordinary prompts. */
export function orchestrationLabel(message: UserMessage) {
  const part = message.parts.find(isOrchestrationPart);
  if (!part) return null;
  if (part.type === "agent_results")
    return part.items.length === 1 ? "Agent result" : `${part.items.length} agent results`;
  return `${threadMessageHeading(part)}: ${firstLine(part.body, 80)}`;
}
