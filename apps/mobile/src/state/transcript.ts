// Client-side transcript projection: seeds from `threads.get`, then folds
// live `ThreadEvent`s into the same `TranscriptEntry` shape the daemon uses.

import type {
  ApprovalId,
  ApprovalRequest,
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
  const turnId = ev.turn_id ?? "";

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
        { role: "user", id: ev.message_id, turn_id: turnId, message: ev.message, at: ev.at },
      ];
      break;

    case "assistant_text_delta":
    case "assistant_thinking_delta": {
      const idx = next.entries.findIndex((e) => e.role === "assistant" && e.id === ev.message_id);
      const isText = ev.kind === "assistant_text_delta";
      if (idx === -1) {
        next.entries = [
          ...next.entries,
          {
            role: "assistant",
            id: ev.message_id,
            turn_id: turnId,
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
      const idx = next.entries.findIndex((e) => e.role === "assistant" && e.id === ev.message_id);
      const entry: TranscriptEntry = {
        role: "assistant",
        id: ev.message_id,
        turn_id: turnId,
        text: ev.text,
        thinking: ev.thinking,
        at: ev.at,
        complete: true,
      };
      next.entries = idx === -1 ? [...next.entries, entry] : replaceAt(next.entries, idx, entry);
      break;
    }

    case "tool_call_started":
      next.entries = [
        ...next.entries,
        { role: "tool_call", turn_id: turnId, call: ev.call, output: null, is_error: false, complete: false, at: ev.at },
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

    case "approval_requested":
      if (!next.pendingApprovals.some((a) => a.id === ev.approval.id)) {
        next.pendingApprovals = [...next.pendingApprovals, ev.approval];
      }
      break;

    case "approval_resolved":
      next.pendingApprovals = next.pendingApprovals.filter((a) => a.id !== ev.approval_id);
      break;

    case "turn_completed":
      next.entries = [
        ...next.entries,
        {
          role: "turn_summary",
          turn_id: turnId,
          stop_reason: ev.stop_reason,
          usage: ev.usage,
          cost_usd: ev.cost_usd,
          duration_ms: ev.duration_ms,
          error: null,
        },
      ];
      break;

    case "turn_failed":
      next.entries = [
        ...next.entries,
        {
          role: "turn_summary",
          turn_id: turnId,
          stop_reason: "error",
          usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
          cost_usd: null,
          duration_ms: 0,
          error: ev.error,
        },
      ];
      break;

    case "provider_notice":
      next.notices = [...next.notices, { id: String(ev.seq), level: ev.level, text: ev.text, at: ev.at }].slice(-20);
      break;

    case "provider_session_bound":
    case "checkpoint_updated":
    case "workspace_reverted":
      break;

    default:
      // Unknown event kinds are ignored per protocol versioning rules.
      break;
  }
  return next;
}

export function removeApproval(state: ThreadState, id: ApprovalId): ThreadState {
  return { ...state, pendingApprovals: state.pendingApprovals.filter((a) => a.id !== id) };
}

function replaceAt<T>(arr: T[], idx: number, value: T): T[] {
  const out = arr.slice();
  out[idx] = value;
  return out;
}
