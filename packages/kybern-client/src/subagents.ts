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

// ---- presentation helpers (subagent page, parent transcript, composer strip, sidebar) ----

/** The slice of a thread the subagent surfaces read. */
export type SubagentThread = {
  id: string;
  title?: string;
  parent_thread_id?: string | null;
  project_id?: string;
  status?: string;
  model?: string | null;
  effort?: string | null;
  subagent?: SubagentInfo | null;
};

/** The thread's subagent record; callers have already checked `isSubagentThread`. */
export function subagentOf(thread: { subagent?: SubagentInfo | null }): SubagentInfo | undefined {
  return thread.subagent ?? undefined;
}

export function subagentThreadPhase(thread: { subagent?: SubagentInfo | null }): SubagentPhase {
  return thread.subagent ? subagentPhase(thread.subagent.status) : "done";
}

/** Not started yet: the harness announced the task but it has produced nothing. */
export function isSubagentQueued(thread: { subagent?: SubagentInfo | null }): boolean {
  return thread.subagent?.status === "pending";
}

/** Claude's `general-purpose` reads as "General"; any other type or role is shown as written. */
export function subagentTypeLabel(agentType: string | null | undefined): string | null {
  const value = agentType?.trim();
  if (!value) return null;
  if (value.toLowerCase() === "general-purpose" || value.toLowerCase() === "general") return "General";
  return value;
}

export interface SubagentCounts {
  working: number;
  done: number;
  failed: number;
  stopped: number;
}

export function subagentCounts(phases: readonly SubagentPhase[]): SubagentCounts {
  const counts: SubagentCounts = { working: 0, done: 0, failed: 0, stopped: 0 };
  for (const phase of phases) counts[phase] += 1;
  return counts;
}

/** The status line of a group: working, done, failed, stopped in that order, zero counts skipped. */
export function subagentStatusSegments(counts: SubagentCounts): { phase: SubagentPhase; text: string }[] {
  const segments: { phase: SubagentPhase; text: string }[] = [];
  for (const phase of ["working", "done", "failed", "stopped"] as const) {
    if (counts[phase] > 0) segments.push({ phase, text: `${counts[phase]} ${phase}` });
  }
  return segments;
}

/** Group title: a single subagent is never a group, so this reads "2 subagents" and up. */
export function subagentGroupTitle(count: number): string {
  return `${count} ${count === 1 ? "subagent" : "subagents"}`;
}

/** Spoken summary of the counts, for assistive technology. */
export function subagentCountsDescription(counts: SubagentCounts): string {
  return subagentStatusSegments(counts).map((segment) => segment.text).join(", ");
}

/**
 * Whether a group of launches starts expanded: open while three or fewer are
 * working, collapsed once everything settled unless one failed. A choice the
 * reader made is kept by the caller and wins over this.
 */
export function subagentGroupDefaultOpen(counts: SubagentCounts): boolean {
  if (counts.working > 0) return counts.working <= 3;
  return counts.failed > 0;
}

type Timed = { subagent?: SubagentInfo | null };

function timeOf(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Start and end of one subagent in epoch ms; `endedAt` is null while it works. */
export function subagentSpan(thread: Timed): { startedAt: number; endedAt: number | null } | null {
  const info = thread.subagent;
  if (!info) return null;
  const startedAt = timeOf(info.started_at);
  if (startedAt === null) return null;
  if (subagentPhase(info.status) === "working") return { startedAt, endedAt: null };
  const endedAt = timeOf(info.completed_at) ?? (typeof info.stats?.duration_ms === "number" ? startedAt + info.stats.duration_ms : null);
  return { startedAt, endedAt };
}

/**
 * Span of a whole group, earliest start to latest end (or still running). Null
 * when a settled member has no end time: a short number would be wrong.
 */
export function subagentGroupSpan(threads: readonly Timed[]): { startedAt: number; endedAt: number | null } | null {
  let startedAt = Infinity;
  let endedAt = -Infinity;
  let running = false;
  for (const thread of threads) {
    const span = subagentSpan(thread);
    if (!span) return null;
    startedAt = Math.min(startedAt, span.startedAt);
    if (span.endedAt === null) {
      if (subagentPhase(thread.subagent!.status) !== "working") return null;
      running = true;
    } else endedAt = Math.max(endedAt, span.endedAt);
  }
  if (!Number.isFinite(startedAt)) return null;
  return { startedAt, endedAt: running ? null : endedAt };
}

/** Elapsed time as clock text: `48s`, `1m 04s`, `1h 02m`. The second unit is zero padded. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${String(total % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** The same duration spoken: `2 minutes 30 seconds`. */
export function spokenElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const unit = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  const parts: string[] = [];
  if (hours) parts.push(unit(hours, "hour"));
  if (minutes) parts.push(unit(minutes, "minute"));
  if (seconds || parts.length === 0) parts.push(unit(seconds, "second"));
  return parts.join(" ");
}

/** `18.2k tokens`; null when the harness reports nothing, so a bar never says "0 tokens". */
export function formatTokenCount(count: number | null | undefined): string | null {
  if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) return null;
  if (count < 1000) return `${Math.round(count)} tokens`;
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 100_000 ? 1 : 0)}k tokens`;
  return `${(count / 1_000_000).toFixed(1)}M tokens`;
}

/** Tokens for a subagent: the provider's own count, else the usage totals. */
export function subagentTokenCount(thread: Timed): number | null {
  const info = thread.subagent;
  if (!info) return null;
  const reported = info.stats?.token_count;
  if (typeof reported === "number" && reported > 0) return reported;
  const usage = info.usage;
  if (!usage) return null;
  const total = usage.input_tokens + usage.output_tokens;
  return total > 0 ? total : null;
}

function firstLine(text: string | null | undefined): string | null {
  const line = text?.split("\n").map((part) => part.trim()).find(Boolean);
  return line || null;
}

/**
 * The line under a subagent's name: live progress while it works, the first
 * line of its result once settled. A failure leads with the error.
 */
export function subagentDetail(thread: Timed): { text: string; failed: boolean } | null {
  const info = thread.subagent;
  if (!info) return null;
  const phase = subagentPhase(info.status);
  if (phase === "working") {
    const live = firstLine(info.progress) ?? firstLine(info.detail) ?? (info.last_tool_name ? `Using ${info.last_tool_name}` : null);
    return live ? { text: live, failed: false } : null;
  }
  const settled = firstLine(info.result) ?? firstLine(info.detail);
  if (phase === "failed") return { text: settled ?? "Failed", failed: true };
  return settled ? { text: settled, failed: false } : null;
}

export type SubagentBarState = {
  phase: SubagentPhase | "queued";
  /** `Starting`, `Working 2m 04s`, `Completed in 3m 41s`, `Failed after 12s`, `Stopped after 12s`. */
  label: string;
};

/** State text of the read-only bar. `elapsedMs` is null when no start time is known. */
export function subagentBarState(thread: Timed, elapsedMs: number | null): SubagentBarState {
  if (isSubagentQueued(thread)) return { phase: "queued", label: "Starting" };
  const phase = subagentThreadPhase(thread);
  const clock = elapsedMs === null ? "" : ` ${formatElapsed(elapsedMs)}`;
  switch (phase) {
    case "working":
      return { phase, label: `Working${clock}` };
    case "done":
      return { phase, label: elapsedMs === null ? "Completed" : `Completed in ${formatElapsed(elapsedMs)}` };
    case "failed":
      return { phase, label: elapsedMs === null ? "Failed" : `Failed after ${formatElapsed(elapsedMs)}` };
    case "stopped":
      return { phase, label: elapsedMs === null ? "Stopped" : `Stopped after ${formatElapsed(elapsedMs)}` };
  }
}

/** Word for a phase in rows and announcements. */
export function subagentPhaseWord(thread: Timed): string {
  if (isSubagentQueued(thread)) return "queued";
  switch (subagentThreadPhase(thread)) {
    case "working":
      return thread.subagent?.backgrounded ? "in background" : "working";
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "stopped":
      return "stopped";
  }
}

/** Accessible name of a row that opens a subagent. */
export function subagentRowLabel(thread: SubagentThread, now: number): string {
  const span = subagentSpan(thread);
  const elapsed = span ? spokenElapsed((span.endedAt ?? now) - span.startedAt) : null;
  return ["Open " + (thread.title || "subagent"), subagentPhaseWord(thread), elapsed].filter(Boolean).join(", ");
}

/** Hook a launch block up to the child thread it started. */
export function findSubagentFor<T extends { subagent?: SubagentInfo | null }>(
  children: readonly T[],
  launch: { toolCallId?: string | null; taskId?: string | null },
): T | undefined {
  return children.find((child) => {
    const info = child.subagent;
    if (!info) return false;
    return (!!launch.taskId && info.task_id === launch.taskId) || (!!launch.toolCallId && info.tool_call_id === launch.toolCallId);
  });
}

/** The direct subagent children of a thread, oldest launch first. */
export function subagentChildren<T extends { id: string; parent_thread_id?: string | null; subagent?: SubagentInfo | null }>(
  threads: Iterable<T>,
  parentId: string,
): T[] {
  const children: T[] = [];
  for (const thread of threads) if (thread.subagent && thread.parent_thread_id === parentId) children.push(thread);
  return children.sort((a, b) => (timeOf(a.subagent!.started_at) ?? 0) - (timeOf(b.subagent!.started_at) ?? 0) || a.id.localeCompare(b.id));
}

/** Chain from the thread that owns the session down to `thread`'s parent (root first). */
export function subagentAncestors<T extends { id: string; parent_thread_id?: string | null }>(
  thread: T,
  byId: (id: string) => T | undefined,
): T[] {
  const chain: T[] = [];
  const seen = new Set<string>([thread.id]);
  let parentId = thread.parent_thread_id;
  while (parentId && !seen.has(parentId)) {
    const parent = byId(parentId);
    if (!parent) break;
    seen.add(parent.id);
    chain.unshift(parent);
    parentId = parent.parent_thread_id;
  }
  return chain;
}

/** Nesting depth: 0 for an ordinary thread, 1 for its subagent, 2 for a subagent of that subagent. */
export function subagentDepth<T extends { id: string; parent_thread_id?: string | null; subagent?: SubagentInfo | null }>(thread: T, byId: (id: string) => T | undefined): number {
  if (!thread.subagent) return 0;
  return 1 + subagentAncestors(thread, byId).filter((ancestor) => !!ancestor.subagent).length;
}

/** How long a finished subagent keeps its row, with a check, before the sidebar lets it go. */
export const SUBAGENT_SIDEBAR_HOLD_MS = 600;
/** A subagent that settled longer ago than this was not seen finishing; its row never appears. */
export const SUBAGENT_SIDEBAR_RECENT_MS = 1500;

/**
 * The subagent threads the sidebar nests under their parents: those working, the one being
 * viewed (it stays until you navigate away), and any that settled a moment ago (its row
 * holds a check, then leaves). Rows dismissed by hand stay gone. A parent subagent is kept
 * while one of its children is still listed, so a nested row never jumps to the top level.
 */
export function visibleSubagentThreads<T extends { id: string; parent_thread_id?: string | null; status?: string; subagent?: SubagentInfo | null }>(
  threads: readonly T[],
  options: { selectedId?: string | null; dismissed: ReadonlySet<string>; now: number },
): T[] {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const keep = new Set<string>();
  for (const thread of threads) {
    const info = thread.subagent;
    if (!info || thread.status === "archived" || options.dismissed.has(thread.id)) continue;
    const working = subagentPhase(info.status) === "working";
    const settledAt = timeOf(info.completed_at);
    const recent = !working && settledAt !== null && options.now - settledAt < SUBAGENT_SIDEBAR_RECENT_MS;
    if (working || recent || thread.id === options.selectedId) keep.add(thread.id);
  }
  for (const id of [...keep]) {
    let parentId = byId.get(id)?.parent_thread_id;
    const seen = new Set<string>([id]);
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = byId.get(parentId);
      if (!parent?.subagent) break;
      if (!options.dismissed.has(parent.id)) keep.add(parent.id);
      parentId = parent.parent_thread_id;
    }
  }
  return threads
    .filter((thread) => keep.has(thread.id))
    .sort((a, b) => (timeOf(a.subagent!.started_at) ?? 0) - (timeOf(b.subagent!.started_at) ?? 0) || a.id.localeCompare(b.id));
}

/**
 * Rows of the composer strip. While the parent turn runs it lists every subagent that turn
 * launched, finished ones included; afterwards only those still working (backgrounded ones
 * outlive the turn). Null when the strip should not show.
 */
export function stripSubagents<T extends { subagent?: SubagentInfo | null }>(
  children: readonly T[],
  options: { turnRunning: boolean; turnId?: string | null },
): { rows: T[]; working: number } | null {
  const working = children.filter((child) => child.subagent && subagentPhase(child.subagent.status) === "working");
  const launchedThisTurn = options.turnRunning
    ? children.filter((child) => child.subagent && (!options.turnId || child.subagent.parent_turn_id === options.turnId))
    : [];
  const rows = [...new Set([...launchedThisTurn, ...working])].sort(
    (a, b) => (timeOf(a.subagent!.started_at) ?? 0) - (timeOf(b.subagent!.started_at) ?? 0),
  );
  if (rows.length === 0 || (working.length === 0 && !options.turnRunning)) return null;
  return { rows, working: working.length };
}

/** Header of the composer strip. */
export function stripLabel(total: number, working: number): string {
  const noun = total === 1 ? "subagent" : "subagents";
  if (working === 0) return `${total} ${noun} finished`;
  return working === total ? `${total} ${noun} working` : `${working} of ${total} ${noun} working`;
}

/** A thread's subagents that a "Stop all" would end. */
export function stoppableSubagents<T extends { subagent?: SubagentInfo | null }>(rows: readonly T[]): T[] {
  return rows.filter((row) => row.subagent && subagentPhase(row.subagent.status) === "working" && row.subagent.capabilities?.stop !== false);
}
