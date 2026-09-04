// Client-side transcript projection: seeds from `threads.get`, then folds
// live `ThreadEvent`s into the same `TranscriptEntry` shape the daemon uses.

import type {
  ApprovalId,
  ApprovalRequest,
  EventOrigin,
  RuntimeTask,
  Thread,
  ThreadEvent,
  ThreadsGetResult,
  TranscriptEntry,
} from "@/protocol";

export interface Notice {
  id: string;
  level: "info" | "warning" | "error";
  text: string;
  at: string;
}

export interface ThreadState {
  thread: Thread | null;
  entries: TranscriptEntry[];
  pendingApprovals: ApprovalRequest[];
  notices: Notice[];
  /** Seq of the last event folded in. */
  lastSeq: number;
}

export const emptyThreadState: ThreadState = {
  thread: null,
  entries: [],
  pendingApprovals: [],
  notices: [],
  lastSeq: 0,
};

const ROOT_ORIGIN = { kind: "root" } as const satisfies EventOrigin;

export function seedFromGet(res: ThreadsGetResult): ThreadState {
  return {
    thread: res.thread,
    entries: res.transcript,
    pendingApprovals: res.pending_approvals,
    notices: [],
    lastSeq: res.thread.last_seq,
  };
}

export function applyEvent(state: ThreadState, ev: ThreadEvent): ThreadState {
  if (ev.seq <= state.lastSeq) return state;
  const next: ThreadState = { ...state, lastSeq: ev.seq };
  const turnId = ev.turn_id ?? (isAssistantEvent(ev) ? latestTurnId(next.entries) : "");

  switch (ev.kind) {
    case "thread_created":
    case "thread_updated":
      next.thread = ev.thread;
      break;

    case "thread_archived":
      if (next.thread) next.thread = { ...next.thread, status: "archived" };
      break;

    case "turn_started":
      next.entries = [
        ...next.entries,
        { role: "user", id: ev.message_id, turn_id: turnId, seq: ev.seq, message: ev.message, at: ev.at },
      ];
      break;

    case "assistant_text_delta":
    case "assistant_thinking_delta": {
      const origin = ev.origin ?? ROOT_ORIGIN;
      if (origin.kind !== "root") break;
      const messageId = ev.turn_id == null ? continuationMessageId(next.entries, turnId, ev.message_id) : ev.message_id;
      const idx = findOpenAssistantSegment(next.entries, messageId, origin);
      const isText = ev.kind === "assistant_text_delta";
      if (idx === -1) {
        const segment = nextAssistantSegment(next.entries, messageId, origin);
        next.entries = [
          ...next.entries,
          {
            role: "assistant",
            id: messageId,
            turn_id: turnId,
            seq: ev.seq,
            origin,
            segment,
            text: isText ? ev.delta : "",
            thinking: isText ? null : ev.delta,
            at: ev.at,
            complete: false,
          },
        ];
      } else {
        const cur = next.entries[idx];
        if (cur && cur.role === "assistant") {
          const updated: TranscriptEntry = isText
            ? { ...cur, text: cur.text + ev.delta }
            : { ...cur, thinking: (cur.thinking ?? "") + ev.delta };
          next.entries = replaceAt(next.entries, idx, updated);
        }
      }
      break;
    }

    case "assistant_message_completed": {
      const origin = ev.origin ?? ROOT_ORIGIN;
      if (origin.kind !== "root") break;
      const messageId = ev.turn_id == null ? continuationMessageId(next.entries, turnId, ev.message_id) : ev.message_id;
      let indices = assistantSegmentIndices(next.entries, messageId, origin);
      if (indices.length === 0) {
        next.entries = [
          ...next.entries,
          {
            role: "assistant",
            id: messageId,
            turn_id: turnId,
            seq: ev.seq,
            origin,
            segment: nextAssistantSegment(next.entries, messageId, origin),
            text: ev.text,
            thinking: ev.thinking,
            at: ev.at,
            complete: true,
          },
        ];
      } else {
        const lastIsTail = indices.at(-1) === next.entries.length - 1;
        const streamedText = indices.map((index) => {
          const entry = next.entries[index];
          return entry?.role === "assistant" ? entry.text : "";
        }).join("");
        const streamedThinking = indices.map((index) => {
          const entry = next.entries[index];
          return entry?.role === "assistant" ? entry.thinking ?? "" : "";
        }).join("");
        const trailingText = !lastIsTail && ev.text.startsWith(streamedText) ? ev.text.slice(streamedText.length) : "";
        const trailingThinking = !lastIsTail && ev.thinking?.startsWith(streamedThinking) ? ev.thinking.slice(streamedThinking.length) : "";
        if (trailingText || trailingThinking) {
          next.entries = [
            ...next.entries,
            {
              role: "assistant",
              id: messageId,
              turn_id: turnId,
              seq: ev.seq,
              origin,
              segment: nextAssistantSegment(next.entries, messageId, origin),
              text: trailingText,
              thinking: trailingThinking,
              at: ev.at,
              complete: true,
            },
          ];
          indices = [...indices, next.entries.length - 1];
        }
        next.entries = reconcileAssistantField(next.entries, indices, ev.text, "text");
        if (ev.thinking != null) next.entries = reconcileAssistantField(next.entries, indices, ev.thinking, "thinking");
        next.entries = next.entries.map((entry, index) =>
          indices.includes(index) && entry.role === "assistant" ? { ...entry, complete: true } : entry,
        );
      }
      break;
    }

    case "tool_call_started":
      next.entries = [
        ...next.entries,
        { role: "tool_call", turn_id: turnId, seq: ev.seq, origin: ev.origin ?? ROOT_ORIGIN, call: ev.call, output: null, is_error: false, complete: false, at: ev.at },
      ];
      break;

    case "tool_call_output_delta": {
      const idx = next.entries.findIndex((e) => e.role === "tool_call" && e.call.id === ev.tool_call_id);
      const cur = next.entries[idx];
      if (cur && cur.role === "tool_call") {
        const prev = typeof cur.output === "string" ? cur.output : "";
        next.entries = replaceAt(next.entries, idx, { ...cur, output: prev + ev.delta });
      }
      break;
    }

    case "tool_call_completed": {
      const idx = next.entries.findIndex((e) => e.role === "tool_call" && e.call.id === ev.tool_call_id);
      const cur = next.entries[idx];
      if (cur && cur.role === "tool_call") {
        next.entries = replaceAt(next.entries, idx, { ...cur, output: ev.output, is_error: ev.is_error, complete: true });
      }
      break;
    }

    case "runtime_task_started":
    case "runtime_task_updated":
    case "runtime_task_completed": {
      const idx = next.entries.findIndex((entry) => entry.role === "runtime_task" && entry.task.id === ev.task.id);
      const current = next.entries[idx];
      const startedSeq = current?.role === "runtime_task"
        ? current.task.started_seq || current.seq
        : ev.task.started_seq || ev.seq;
      const task = { ...ev.task, started_seq: startedSeq, updated_seq: ev.seq };
      if (current?.role === "runtime_task") {
        if (isActiveRuntimeStatus(current.task.status) || !isActiveRuntimeStatus(task.status)) {
          next.entries = replaceAt(next.entries, idx, { ...current, task });
        }
      } else {
        next.entries = [
          ...next.entries,
          { role: "runtime_task", turn_id: task.origin_turn_id || turnId, seq: startedSeq, task, at: task.started_at || ev.at },
        ];
      }
      break;
    }

    case "approval_requested":
      if (!next.pendingApprovals.some((a) => a.id === ev.approval.id)) {
        next.pendingApprovals = [...next.pendingApprovals, ev.approval];
      }
      next.entries = [
        ...next.entries,
        { role: "approval", turn_id: turnId, seq: ev.seq, approval: ev.approval, decision: null },
      ];
      break;

    case "approval_resolved": {
      next.pendingApprovals = next.pendingApprovals.filter((a) => a.id !== ev.approval_id);
      const idx = next.entries.findIndex((entry) => entry.role === "approval" && entry.approval.id === ev.approval_id);
      const current = next.entries[idx];
      if (current?.role === "approval") next.entries = replaceAt(next.entries, idx, { ...current, decision: ev.decision });
      break;
    }

    case "turn_completed":
      next.entries = [
        ...finishTurn(next.entries, turnId),
        {
          role: "turn_summary",
          turn_id: turnId,
          seq: ev.seq,
          stop_reason: ev.stop_reason,
          usage: ev.usage,
          cost_usd: ev.cost_usd,
          duration_ms: ev.duration_ms,
          terminal_message_id: ev.terminal_message_id ?? null,
          at: ev.at,
          error: null,
        },
      ];
      break;

    case "turn_failed":
      next.entries = [
        ...finishTurn(next.entries, turnId),
        {
          role: "turn_summary",
          turn_id: turnId,
          seq: ev.seq,
          stop_reason: "error",
          usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
          cost_usd: null,
          duration_ms: 0,
          terminal_message_id: null,
          at: ev.at,
          error: ev.error,
        },
      ];
      break;

    case "provider_notice":
      next.notices = [...next.notices, { id: String(ev.seq), level: ev.level, text: ev.text, at: ev.at }].slice(-20);
      next.entries = [...next.entries, { role: "notice", turn_id: turnId, seq: ev.seq, level: ev.level, text: ev.text, at: ev.at }];
      break;

    case "provider_session_bound":
    case "checkpoint_updated":
      break;

    case "workspace_reverted":
      next.entries = [...next.entries, { role: "reverted", turn_id: turnId, seq: ev.seq, commit: ev.commit, at: ev.at }];
      break;

    default:
      // Unknown event kinds are ignored per protocol versioning rules.
      break;
  }
  return next;
}

function isAssistantEvent(ev: ThreadEvent): boolean {
  return ev.kind === "assistant_text_delta" || ev.kind === "assistant_thinking_delta" || ev.kind === "assistant_message_completed";
}

function latestTurnId(entries: readonly TranscriptEntry[]): string {
  for (let index = entries.length - 1; index >= 0; index--) {
    const turnId = entries[index]?.turn_id;
    if (turnId) return turnId;
  }
  return "";
}

function continuationMessageId(entries: readonly TranscriptEntry[], turnId: string, incoming: string): string {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.role === "turn_summary" && entry.turn_id === turnId) break;
    if (entry?.role === "assistant" && entry.turn_id === turnId && !entry.complete) return entry.id;
  }
  return incoming;
}

export function removeApproval(state: ThreadState, id: ApprovalId): ThreadState {
  return { ...state, pendingApprovals: state.pendingApprovals.filter((a) => a.id !== id) };
}

function findOpenAssistantSegment(entries: readonly TranscriptEntry[], messageId: string, origin: EventOrigin): number {
  const index = entries.length - 1;
  const entry = entries[index];
  return entry?.role === "assistant" && !entry.complete && entry.id === messageId && sameOrigin(entry.origin, origin) ? index : -1;
}

function nextAssistantSegment(entries: readonly TranscriptEntry[], messageId: string, origin: EventOrigin): number {
  let max = -1;
  for (const entry of entries) {
    if (entry.role === "assistant" && entry.id === messageId && sameOrigin(entry.origin, origin)) {
      max = Math.max(max, entry.segment ?? 0);
    }
  }
  return max + 1;
}

function assistantSegmentIndices(entries: readonly TranscriptEntry[], messageId: string, origin: EventOrigin): number[] {
  return entries.flatMap((entry, index) =>
    entry.role === "assistant" && entry.id === messageId && sameOrigin(entry.origin, origin) ? [index] : [],
  );
}

function sameOrigin(left: EventOrigin, right: EventOrigin): boolean {
  return left.kind === right.kind &&
    (left.kind === "root" ||
      (right.kind === "agent" && left.task_id === right.task_id && left.provider_thread_id === right.provider_thread_id));
}

function reconcileAssistantField(
  entries: TranscriptEntry[],
  indices: readonly number[],
  canonical: string,
  field: "text" | "thinking",
): TranscriptEntry[] {
  const pieces = indices.map((index) => {
    const entry = entries[index];
    return entry?.role === "assistant" ? entry[field] ?? "" : "";
  });
  const streamed = pieces.join("");
  if (streamed === canonical) return entries;

  let commonPrefix = 0;
  const streamedChars = Array.from(streamed);
  const canonicalChars = Array.from(canonical);
  for (let position = 0; position < streamedChars.length; position++) {
    if (streamedChars[position] !== canonicalChars[position]) break;
    commonPrefix += streamedChars[position]!.length;
  }

  let targetPosition = field === "thinking" ? 0 : indices.length - 1;
  if (streamed.length > 0) {
    let consumed = 0;
    const found = pieces.findIndex((piece) => {
      const contains = commonPrefix < consumed + piece.length;
      consumed += piece.length;
      return contains;
    });
    if (found !== -1) targetPosition = found;
  }
  const consumedBefore = pieces.slice(0, targetPosition).reduce((total, piece) => total + piece.length, 0);
  const keep = Math.min(Math.max(0, commonPrefix - consumedBefore), pieces[targetPosition]?.length ?? 0);
  const replacement = `${pieces[targetPosition]?.slice(0, keep) ?? ""}${canonical.slice(commonPrefix)}`;

  const next = entries.slice();
  indices.forEach((index, position) => {
    const entry = next[index];
    if (entry?.role !== "assistant") return;
    const value = position < targetPosition ? pieces[position]! : position === targetPosition ? replacement : "";
    next[index] = { ...entry, [field]: field === "thinking" && value.length === 0 ? null : value };
  });
  return next;
}

function isActiveRuntimeStatus(status: RuntimeTask["status"]): boolean {
  return status === "pending" || status === "running" || status === "waiting" || status === "stopping";
}

function finishTurn(entries: TranscriptEntry[], turnId: string): TranscriptEntry[] {
  return entries.map((entry) => {
    if (entry.turn_id !== turnId) return entry;
    if (entry.role === "assistant" && !entry.complete) return { ...entry, complete: true };
    if (entry.role === "tool_call" && !entry.complete) return { ...entry, complete: true, output: entry.output ?? null };
    return entry;
  });
}

function replaceAt<T>(arr: T[], idx: number, value: T): T[] {
  const out = arr.slice();
  out[idx] = value;
  return out;
}
