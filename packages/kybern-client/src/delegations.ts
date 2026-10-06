// Pure presentation rules for Orchestrator V2: delegated child threads, the Lineage tree,
// result previews, inbound thread messages and the held-message panel. No React and no
// store, so the desktop and mobile clients share them.

import { subagentPhase } from "./subagents.ts";
import type {
  AgentResultItem,
  ContentPart,
  DelegationInfo,
  DelegationRole,
  DelegationStatus,
  DiffStat,
  SubagentInfo,
  ThreadMessagePart,
  ThreadMessagePurpose,
  ThreadMessageRecord,
  ThreadMessageState,
  UserMessage,
} from "./types.ts";

/** The slice of a thread these rules read. */
export type LineageThread = {
  id: string;
  title?: string;
  parent_thread_id?: string | null;
  status?: string;
  created_at?: string;
  worktree?: { path: string; branch: string } | null;
  subagent?: SubagentInfo | null;
  delegation?: DelegationInfo | null;
};

/** A thread another thread delegated to with `kybern_agent_delegate`. */
export function isDelegatedThread(thread: { delegation?: DelegationInfo | null } | null | undefined): boolean {
  return !!thread?.delegation;
}

// ---- status: shape plus word, never colour alone ----

export type ChildPhase = "working" | "waiting" | "done" | "failed" | "stopped" | "idle";

/** Word beside the glyph. `Interrupted` keeps its own word: a restart cut it off, nobody stopped it. */
export function delegationStatusWord(status: DelegationStatus): string {
  switch (status) {
    case "running":
      return "Working";
    case "completed":
      return "Done";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Stopped";
    case "interrupted":
      return "Interrupted";
  }
}

/** Glyph phase and word of a bare delegation status, for a launch row that has only the call's result. */
export function delegationState(status: DelegationStatus): { phase: ChildPhase; word: string } {
  return { phase: delegationPhase(status), word: delegationStatusWord(status) };
}

function delegationPhase(status: DelegationStatus): ChildPhase {
  switch (status) {
    case "running":
      return "working";
    case "completed":
      return "done";
    case "failed":
      return "failed";
    default:
      return "stopped";
  }
}

/** What a Lineage row says about one child: its glyph phase and the word that goes with it. */
export function childState(thread: LineageThread): { phase: ChildPhase; word: string } {
  if (thread.delegation) {
    const info = thread.delegation;
    // A child that needs an answer is not "working": nothing moves until you open it.
    if (info.status === "running" && thread.status === "awaiting-approval") return { phase: "waiting", word: "Needs approval" };
    return { phase: delegationPhase(info.status), word: delegationStatusWord(info.status) };
  }
  if (thread.subagent) {
    const phase = subagentPhase(thread.subagent.status);
    if (thread.subagent.status === "pending") return { phase: "working", word: "Starting" };
    if (phase === "working") return { phase: "working", word: thread.subagent.backgrounded ? "In background" : "Working" };
    if (phase === "done") return { phase: "done", word: "Done" };
    if (phase === "failed") return { phase: "failed", word: "Failed" };
    return { phase: "stopped", word: thread.subagent.status === "interrupted" ? "Interrupted" : "Stopped" };
  }
  switch (thread.status) {
    case "running":
      return { phase: "working", word: "Working" };
    case "awaiting-approval":
      return { phase: "waiting", word: "Needs approval" };
    case "failed":
      return { phase: "failed", word: "Failed" };
    default:
      return { phase: "idle", word: "Idle" };
  }
}

/** Still moving: the row shows a live clock and the Stop action (when it can). */
export function isChildWorking(thread: LineageThread): boolean {
  const { phase } = childState(thread);
  return phase === "working" || phase === "waiting";
}

// ---- roles and workspaces ----

const ROLE_LABEL: Record<DelegationRole, string> = {
  implementation: "Implementation",
  research: "Research",
  review: "Review",
  design: "Design",
  test: "Test",
  general: "General",
};

export function delegationRoleLabel(role: DelegationRole): string {
  return ROLE_LABEL[role] ?? "General";
}

/** `kybern/4f2a91c3-…` reads as `kybern/4f2a91c3`; any other branch is shown as written. */
export function shortBranch(branch: string): string {
  return branch.replace(/^(kybern\/[0-9a-f]{8})[0-9a-f-]{4,}$/i, "$1");
}

/** Where the child edits: `Shared checkout`, `Own worktree`, `Worktree kept` or `Worktree removed`. */
export function workspaceLabel(info: Pick<DelegationInfo, "workspace" | "worktree_state">): string {
  if (info.workspace === "shared") return "Shared checkout";
  if (info.worktree_state === "kept") return "Worktree kept";
  if (info.worktree_state === "removed") return "Worktree removed";
  return "Own worktree";
}

export function canStopDelegation(thread: LineageThread): boolean {
  return !thread.subagent && thread.delegation?.status === "running";
}

/** Only a kept worktree can be removed by hand; removing it is the one destructive Lineage action. */
export function canRemoveWorktree(info: Pick<DelegationInfo, "workspace" | "worktree_state"> | null | undefined): boolean {
  return info?.workspace === "worktree" && info.worktree_state === "kept";
}

export function filesLabel(count: number): string {
  return `${count} ${count === 1 ? "file" : "files"}`;
}

export function conflictsLabel(count: number): string {
  return `${count} ${count === 1 ? "conflict" : "conflicts"}`;
}

/** `3 files · +120 −8`. The minus is U+2212, like the flattened text agents read. */
export function diffstatLabel(stat: DiffStat): string {
  return `${filesLabel(stat.files)} · +${stat.additions} −${stat.deletions}`;
}

/** Paths a sibling owns that this child touched, deduped by path. */
export function conflictPaths(info: Pick<DelegationInfo, "conflicts">): string[] {
  return [...new Set((info.conflicts ?? []).map((conflict) => conflict.path))];
}

// ---- result previews ----

/** One plain line from agent text: markdown marks gone, spaces collapsed, cut at a word. */
export function plainLine(text: string | null | undefined, limit = 140): string {
  const source = (text ?? "").slice(0, 2048);
  const first = source.split("\n").map((line) => line.trim()).find((line) => line && !/^```/.test(line)) ?? "";
  const plain = first
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[#>\-*+\s]+/, "")
    .replace(/(^|[\s(])(_{1,2})([^_\s][^_]*?)\2(?=[\s).,;:!?]|$)/g, "$1$3")
    .replace(/[*`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= limit) return plain;
  const prefix = plain.slice(0, limit);
  const space = prefix.lastIndexOf(" ");
  return `${prefix.slice(0, space > limit * 0.65 ? space : limit).trimEnd()}…`;
}

/** Preview of a settled child: the error leads when it failed, else the first line of its result. */
export function resultPreview(item: Pick<AgentResultItem, "status" | "result" | "error">, limit = 140): string {
  if (item.status === "failed" || item.status === "interrupted") {
    const error = plainLine(item.error, limit);
    if (error) return error;
  }
  return plainLine(item.result, limit) || plainLine(item.error, limit);
}

/** A result longer than this many lines or characters is clamped behind "Show more". */
export const RESULT_CLAMP_LINES = 8;
export const RESULT_CLAMP_CHARS = 720;

export function resultNeedsClamp(text: string): boolean {
  if (text.length > RESULT_CLAMP_CHARS) return true;
  return text.split("\n").length > RESULT_CLAMP_LINES;
}

// ---- Lineage tree ----

export type LineageKind = "delegated" | "native" | "helper";

export function lineageKind(thread: LineageThread): LineageKind {
  return thread.delegation ? "delegated" : thread.subagent ? "native" : "helper";
}

function timeOf(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Start of a child in epoch ms: the clock of its record, else when the thread was created. */
export function childStartedAt(thread: LineageThread): number {
  return timeOf(thread.delegation?.started_at ?? thread.subagent?.started_at ?? thread.created_at);
}

/** End of a settled child, or null while it works or when nothing recorded one. */
export function childEndedAt(thread: LineageThread): number | null {
  if (isChildWorking(thread)) return null;
  const ended = timeOf(thread.delegation?.completed_at ?? thread.subagent?.completed_at);
  return ended > 0 ? ended : null;
}

export interface LineageRow<T extends LineageThread> {
  thread: T;
  kind: LineageKind;
  depth: number;
  childCount: number;
  open: boolean;
  phase: ChildPhase;
}

/**
 * The thread's descendants, flattened in tree order for a list. Siblings keep launch order, so a
 * row never moves when its state changes. A row starts open while it or anything beneath it is
 * still working; the reader's choice in `expanded` wins. Archived threads and cycles are skipped.
 */
export function lineageRows<T extends LineageThread>(
  threads: Iterable<T>,
  rootId: string,
  options: { expanded?: Readonly<Record<string, boolean>>; maxDepth?: number } = {},
): LineageRow<T>[] {
  const expanded = options.expanded ?? {};
  const maxDepth = options.maxDepth ?? 4;
  const children = new Map<string, T[]>();
  for (const thread of threads) {
    if (!thread.parent_thread_id || thread.status === "archived" || thread.id === rootId) continue;
    const list = children.get(thread.parent_thread_id) ?? [];
    list.push(thread);
    children.set(thread.parent_thread_id, list);
  }
  for (const list of children.values()) list.sort((a, b) => childStartedAt(a) - childStartedAt(b) || a.id.localeCompare(b.id));

  const activeBeneath = new Map<string, boolean>();
  const hasActive = (thread: T, seen: Set<string>): boolean => {
    const known = activeBeneath.get(thread.id);
    if (known !== undefined) return known;
    if (seen.has(thread.id)) return false;
    seen.add(thread.id);
    const active = isChildWorking(thread) || (children.get(thread.id) ?? []).some((child) => hasActive(child, seen));
    activeBeneath.set(thread.id, active);
    return active;
  };

  const rows: LineageRow<T>[] = [];
  const visited = new Set<string>([rootId]);
  const append = (thread: T, depth: number) => {
    if (visited.has(thread.id)) return;
    visited.add(thread.id);
    const nested = depth < maxDepth ? (children.get(thread.id) ?? []).filter((child) => !visited.has(child.id)) : [];
    const open = expanded[thread.id] ?? hasActive(thread, new Set());
    rows.push({ thread, kind: lineageKind(thread), depth, childCount: nested.length, open, phase: childState(thread).phase });
    if (open) for (const child of nested) append(child, depth + 1);
  };
  for (const child of children.get(rootId) ?? []) append(child, 0);
  return rows;
}

/** Every descendant of `rootId` in tree order, launch order among siblings. Archived threads and cycles are skipped. */
export function descendantsOf<T extends LineageThread>(threads: Iterable<T>, rootId: string): T[] {
  const byParent = new Map<string, T[]>();
  for (const thread of threads) {
    if (!thread.parent_thread_id || thread.status === "archived") continue;
    const list = byParent.get(thread.parent_thread_id) ?? [];
    list.push(thread);
    byParent.set(thread.parent_thread_id, list);
  }
  const found: T[] = [];
  const seen = new Set<string>([rootId]);
  const walk = (id: string) => {
    const children = (byParent.get(id) ?? []).sort((a, b) => childStartedAt(a) - childStartedAt(b) || a.id.localeCompare(b.id));
    for (const child of children) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      found.push(child);
      walk(child.id);
    }
  };
  walk(rootId);
  return found;
}

export interface LineageCounts {
  working: number;
  waiting: number;
  done: number;
  failed: number;
  stopped: number;
  idle: number;
  total: number;
}

/** Counts over every descendant, shown rows or not, so a collapsed branch still counts. */
export function lineageCounts(threads: Iterable<LineageThread>, rootId: string): LineageCounts {
  const counts: LineageCounts = { working: 0, waiting: 0, done: 0, failed: 0, stopped: 0, idle: 0, total: 0 };
  const all = [...threads].filter((thread) => thread.status !== "archived");
  const byParent = new Map<string, LineageThread[]>();
  for (const thread of all) {
    if (!thread.parent_thread_id) continue;
    const list = byParent.get(thread.parent_thread_id) ?? [];
    list.push(thread);
    byParent.set(thread.parent_thread_id, list);
  }
  const seen = new Set<string>([rootId]);
  const walk = (id: string) => {
    for (const child of byParent.get(id) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      counts[childState(child).phase] += 1;
      counts.total += 1;
      walk(child.id);
    }
  };
  walk(rootId);
  return counts;
}

/** `2 working · 1 done · 1 failed`; idle helpers are not counted, they have nothing to report. */
export function lineageSummary(counts: LineageCounts): string {
  const parts: string[] = [];
  if (counts.working > 0) parts.push(`${counts.working} working`);
  if (counts.waiting > 0) parts.push(`${counts.waiting} ${counts.waiting === 1 ? "needs" : "need"} approval`);
  if (counts.done > 0) parts.push(`${counts.done} done`);
  if (counts.failed > 0) parts.push(`${counts.failed} failed`);
  if (counts.stopped > 0) parts.push(`${counts.stopped} stopped`);
  return parts.join(" · ");
}

/** Descendants a Stop on `rootId` would end: delegated and still running. */
export function stoppableDescendants<T extends LineageThread>(rows: readonly LineageRow<T>[]): T[] {
  return rows.filter((row) => canStopDelegation(row.thread)).map((row) => row.thread);
}

// ---- transcript rows: launch status ----

/** The word and phase of a delegation launch row, from its child thread when it is known. */
export function launchState(thread: LineageThread | undefined, call: { complete: boolean; isError: boolean }): { phase: ChildPhase; word: string } {
  if (thread) return childState(thread);
  if (!call.complete) return { phase: "working", word: "Starting" };
  return call.isError ? { phase: "failed", word: "Failed" } : { phase: "working", word: "Working" };
}

export interface LaunchCounts {
  working: number;
  done: number;
  failed: number;
  stopped: number;
}

/** Group header counts: waiting counts as working, idle as done. */
export function launchCounts(phases: readonly ChildPhase[]): LaunchCounts {
  const counts: LaunchCounts = { working: 0, done: 0, failed: 0, stopped: 0 };
  for (const phase of phases) {
    if (phase === "working" || phase === "waiting") counts.working += 1;
    else if (phase === "failed") counts.failed += 1;
    else if (phase === "stopped") counts.stopped += 1;
    else counts.done += 1;
  }
  return counts;
}

export function launchGroupTitle(count: number): string {
  return `${count} delegated ${count === 1 ? "agent" : "agents"}`;
}

/** Same rule as subagents: open while three or fewer work, collapsed once settled unless one failed. */
export function launchGroupDefaultOpen(counts: LaunchCounts): boolean {
  if (counts.working > 0) return counts.working <= 3;
  return counts.failed > 0;
}

// ---- thread messages ----

const PURPOSE_LABEL: Record<ThreadMessagePurpose, string> = {
  task: "Task",
  message: "Message",
  question: "Question",
  reply: "Reply",
  warning: "Warning",
};

export function purposeLabel(purpose: ThreadMessagePurpose): string {
  return PURPOSE_LABEL[purpose] ?? "Message";
}

/** `from_thread_id` is absent when Kybern itself sent it. */
export function messageSenderName(part: Pick<ThreadMessagePart, "from_thread_id" | "from_title">): string {
  if (!part.from_thread_id) return "Kybern";
  return part.from_title.trim() || "Another thread";
}

export function threadMessagePart(parts: readonly ContentPart[]): ThreadMessagePart | undefined {
  return parts.find((part): part is ThreadMessagePart => part.type === "thread_message");
}

export function agentResultItems(parts: readonly ContentPart[]): AgentResultItem[] | undefined {
  const part = parts.find((candidate): candidate is Extract<ContentPart, { type: "agent_results" }> => candidate.type === "agent_results");
  return part?.items;
}

/** One line for queues, navigation and notices: `Question from Review sign-in`, `Results from 3 agents`. */
export function structuredMessageSummary(message: Pick<UserMessage, "parts">): string | null {
  const inbound = threadMessagePart(message.parts);
  if (inbound) return `${purposeLabel(inbound.purpose)} from ${messageSenderName(inbound)}`;
  const items = agentResultItems(message.parts);
  if (items) return items.length === 1 ? "Result from 1 agent" : `Results from ${items.length} agents`;
  return null;
}

/** The readable body of a structured message, for a queue preview: the message text, or one line per agent. */
export function structuredMessageBody(message: Pick<UserMessage, "parts">): string | null {
  const inbound = threadMessagePart(message.parts);
  if (inbound) return inbound.body;
  const items = agentResultItems(message.parts);
  if (items) return items.map((item) => `${item.title}: ${delegationStatusWord(item.status)}${resultPreview(item, 100) ? ` — ${resultPreview(item, 100)}` : ""}`).join("\n");
  return null;
}

/** Sentence for the held panel: `Review sign-in wants to send a question`. */
export function heldHeadline(sender: string, purpose: ThreadMessagePurpose): string {
  const noun = purpose === "task" ? "a task" : purpose === "question" ? "a question" : purpose === "reply" ? "a reply" : purpose === "warning" ? "a warning" : "a message";
  return `${sender} wants to send ${noun}`;
}

/** Messages that still wait for you in this thread, oldest first. */
export function heldMessages(messages: readonly ThreadMessageRecord[]): ThreadMessageRecord[] {
  return messages.filter((message) => message.state === "held").sort((a, b) => timeOf(a.created_at) - timeOf(b.created_at) || a.id.localeCompare(b.id));
}

/** The word a "Sent to" row shows for a message state. */
export function messageStateWord(state: ThreadMessageState | "steered" | "queued" | "held" | string): string {
  switch (state) {
    case "held":
      return "Held for approval";
    case "queued":
      return "Queued";
    case "steered":
      return "Sent now";
    case "delivered":
      return "Delivered";
    case "answered":
      return "Answered";
    case "dismissed":
      return "Dismissed";
    case "failed":
      return "Not delivered";
    default:
      return "Sent";
  }
}
