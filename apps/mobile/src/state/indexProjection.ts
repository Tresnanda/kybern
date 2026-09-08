import type {
  ApprovalRequest,
  QueuedMessage,
  Thread,
  ThreadEvent,
} from "../../../../packages/kybern-client/src/types.ts";
export interface ThreadIndex {
  threads: Thread[];
  approvals: ApprovalRequest[];
  queue: QueuedMessage[];
}
/** Fold live control events over index snapshots as well as the current screen.
 * Text deltas intentionally do no work here: background threads don't render text.
 */
export function applyIndexEvent<S extends ThreadIndex>(
  state: S,
  event: ThreadEvent,
): S {
  switch (event.kind) {
    case "thread_created":
    case "thread_updated": {
      const current = state.threads.find((t) => t.id === event.thread.id);
      if (current && current.last_seq > event.seq) return state;
      return {
        ...state,
        threads: [
          event.thread,
          ...state.threads.filter((t) => t.id !== event.thread.id),
        ],
      };
    }
    case "thread_archived":
      return {
        ...state,
        threads: state.threads.map((t) =>
          t.id === event.thread_id && t.last_seq <= event.seq
            ? { ...t, status: "archived", last_seq: event.seq }
            : t,
        ),
      };
    case "turn_started":
    case "turn_resumed":
    case "turn_completed":
    case "turn_failed":
      return {
        ...state,
        threads: state.threads.map((t) =>
          t.id === event.thread_id && t.last_seq <= event.seq
            ? {
                ...t,
                status:
                  event.kind === "turn_started" || event.kind === "turn_resumed"
                    ? "running"
                    : event.kind === "turn_failed"
                      ? "failed"
                      : "idle",
                last_seq: event.seq,
                updated_at: event.at,
              }
            : t,
        ),
        queue:
          event.kind === "turn_started"
            ? state.queue.filter((q) => q.id !== event.message_id)
            : state.queue,
      };
    case "approval_requested":
    case "user_input_requested":
      return {
        ...state,
        approvals: [
          ...state.approvals.filter((a) => a.id !== event.approval.id),
          event.approval,
        ],
      };
    case "approval_resolved":
      return {
        ...state,
        approvals: state.approvals.filter((a) => a.id !== event.approval_id),
      };
    case "message_queued":
      return {
        ...state,
        queue: [
          ...state.queue.filter((q) => q.id !== event.message.id),
          event.message,
        ],
      };
    case "message_removed":
      return {
        ...state,
        queue: state.queue.filter((q) => q.id !== event.message_id),
      };
    default:
      return state;
  }
}
