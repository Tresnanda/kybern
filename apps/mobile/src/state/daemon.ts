// App-wide view of the daemon: projects, threads and pending approvals, kept
// live from the global event subscription. One store so the list, the badge
// and the approvals tab agree.

import { useEffect, useSyncExternalStore } from "react";
import type { ApprovalRequest, KybernClient, Project, Thread, ThreadEvent } from "@/protocol";

export interface DaemonState {
  projects: Project[];
  threads: Map<string, Thread>;
  approvals: Map<string, ApprovalRequest>;
  loaded: boolean;
  error: string | null;
}

let state: DaemonState = { projects: [], threads: new Map(), approvals: new Map(), loaded: false, error: null };
const listeners = new Set<() => void>();

function emit(next: Partial<DaemonState>) {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useDaemon(): DaemonState {
  return useSyncExternalStore(subscribe, () => state);
}

export function resetDaemon() {
  emit({ projects: [], threads: new Map(), approvals: new Map(), loaded: false, error: null });
}

export function forgetApproval(id: string) {
  const approvals = new Map(state.approvals);
  approvals.delete(id);
  emit({ approvals });
}

export function patchThread(thread: Thread) {
  emit({ threads: new Map(state.threads).set(thread.id, thread) });
}

export async function refreshDaemon(client: KybernClient): Promise<void> {
  try {
    const [p, tl, al] = await Promise.all([
      client.call("projects.list", {}),
      client.call("threads.list", {}),
      client.call("approvals.list", {}),
    ]);
    emit({
      projects: p.projects,
      threads: new Map(tl.threads.map((t) => [t.id, t])),
      approvals: new Map(al.approvals.map((a) => [a.id, a])),
      loaded: true,
      error: null,
    });
  } catch (e) {
    emit({ loaded: true, error: e instanceof Error ? e.message : String(e) });
  }
}

function fold(ev: ThreadEvent) {
  switch (ev.kind) {
    case "thread_created":
    case "thread_updated":
      emit({ threads: new Map(state.threads).set(ev.thread.id, ev.thread) });
      break;
    case "thread_archived": {
      const threads = new Map(state.threads);
      const cur = threads.get(ev.thread_id);
      if (cur) threads.set(ev.thread_id, { ...cur, status: "archived" });
      const approvals = new Map(state.approvals);
      for (const [id, a] of approvals) if (a.thread_id === ev.thread_id) approvals.delete(id);
      emit({ threads, approvals });
      break;
    }
    case "approval_requested":
    case "user_input_requested":
      emit({ approvals: new Map(state.approvals).set(ev.approval.id, ev.approval) });
      break;
    case "approval_resolved":
      forgetApproval(ev.approval_id);
      break;
    default:
      break;
  }
}

/** Mount once near the root while a client exists. */
export function useDaemonSync(client: KybernClient | null) {
  useEffect(() => {
    if (!client) {
      resetDaemon();
      return;
    }
    if (client.status === "open") void refreshDaemon(client);
    const off = client.onStatus((s) => {
      if (s === "open") void refreshDaemon(client);
    });
    const sub = client.subscribeEvents({}, fold, () => void refreshDaemon(client));
    return () => {
      off();
      sub.unsubscribe();
    };
  }, [client]);
}
