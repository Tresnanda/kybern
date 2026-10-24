// What the thread lists know beyond `threads.list`: which threads need the reader
// (unread finished turns, dismissed attention, waiting requests) and the delegated
// and subagent children nested under their parents. Rules are the desktop's,
// shared through `threadAttention.ts`, `subagents.ts` and `threadRows.ts`.
import { pendingOf, type AttentionSignals, type ThreadPending } from "../../../../packages/kybern-client/src/threadAttention";
import { isChildThread } from "../../../../packages/kybern-client/src/subagents";
import { useSyncExternalStore } from "react";
import type { Thread, ThreadActivitySummary } from "./protocol";
import { EMPTY_PREFS, readPrefs, writePrefs, type ListPrefs } from "./prefs";
import {
  activeEnvironment,
  currentClient,
  getState,
  isThreadOpen,
  onEnvironmentReset,
  onSubscriptionReady,
  onThreadEvent,
  onThreadOpen,
  subscribeApp,
} from "./runtime";

type ListState = ListPrefs & {
  pending: Record<string, ThreadPending>;
  /** Delegated and subagent children by id (left out of `threads.list`). */
  children: Record<string, Thread>;
};

let state: ListState = { ...EMPTY_PREFS, pending: {}, children: {} };
let environmentId: string | null = null;
const listeners = new Set<() => void>();
function publish(patch: Partial<ListState>) {
  state = { ...state, ...patch };
  listeners.forEach((fn) => fn());
  if (environmentId && ("unread" in patch || "attentionDismissals" in patch || "projectOrder" in patch))
    writePrefs(environmentId, {
      unread: state.unread,
      attentionDismissals: state.attentionDismissals,
      projectOrder: state.projectOrder,
    });
}
function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
const read = () => state;
export function useListState() {
  return useSyncExternalStore(subscribe, read, read);
}

/** The signals `threadAttention` reads. */
export function attentionSignals(s: ListState = state): AttentionSignals {
  return { unread: s.unread, attentionDismissals: s.attentionDismissals, pending: s.pending };
}

function hydrate() {
  const id = activeEnvironment()?.id ?? null;
  if (id === environmentId) return;
  environmentId = id;
  state = { ...(id ? readPrefs(id) : EMPTY_PREFS), pending: {}, children: {} };
  listeners.forEach((fn) => fn());
}

onEnvironmentReset(() => {
  environmentId = null;
  state = { ...EMPTY_PREFS, pending: {}, children: {} };
  listeners.forEach((fn) => fn());
});
onSubscriptionReady(hydrate);

// ---- unread: a turn that completes while its thread isn't on screen ----

onThreadEvent((event) => {
  switch (event.kind) {
    case "turn_completed": {
      if (event.stop_reason !== "completed" || isThreadOpen(event.thread_id)) return;
      const thread = getState().threads.find((t) => t.id === event.thread_id);
      if (!thread || thread.parent_thread_id || state.unread[event.thread_id]) return;
      publish({ unread: { ...state.unread, [event.thread_id]: true } });
      return;
    }
    case "thread_created":
    case "thread_updated":
      if (isChildThread(event.thread)) upsertChild(event.thread);
      return;
    case "thread_archived":
      if (state.children[event.thread_id]) {
        const children = { ...state.children };
        delete children[event.thread_id];
        publish({ children });
      }
      return;
    case "runtime_task_started":
      if (event.task.kind === "agent") void loadChildren(event.thread_id);
      return;
  }
});

onThreadOpen((id) => {
  if (!state.unread[id]) return;
  const unread = { ...state.unread };
  delete unread[id];
  publish({ unread });
});

/** Wave every thread that asks for attention off (until something new happens on it). */
export function dismissAttention(threads: readonly Thread[]) {
  const attentionDismissals = { ...state.attentionDismissals };
  const unread = { ...state.unread };
  for (const thread of threads) {
    attentionDismissals[thread.id] = thread.last_seq;
    delete unread[thread.id];
  }
  publish({ unread, attentionDismissals });
}

export function markUnread(id: string) {
  publish({ unread: { ...state.unread, [id]: true } });
}
export function markRead(id: string) {
  if (!state.unread[id]) return;
  const unread = { ...state.unread };
  delete unread[id];
  publish({ unread });
}

// ---- waiting requests and children, from `threads.list` activity ----

let lastActivity: ThreadActivitySummary[] | null = null;
subscribeApp(() => {
  const activity = getState().activity;
  if (activity === lastActivity) return;
  lastActivity = activity;
  const pending: Record<string, ThreadPending> = {};
  for (const summary of activity) {
    const waiting = pendingOf(summary);
    if (waiting) pending[summary.thread_id] = waiting;
    // Delegated children are not runtime tasks of their parent: they count in `active_children`.
    if (summary.active_agents > 0 || (summary.active_children ?? 0) > 0) void loadChildren(summary.thread_id);
  }
  if (JSON.stringify(pending) !== JSON.stringify(state.pending)) publish({ pending });
});

function upsertChild(thread: Thread) {
  const current = state.children[thread.id];
  if (thread.status === "archived") {
    if (!current) return;
    const children = { ...state.children };
    delete children[thread.id];
    publish({ children });
    return;
  }
  if (current && current.last_seq > thread.last_seq) return;
  publish({ children: { ...state.children, [thread.id]: thread } });
}

const childLoads = new Map<string, Promise<void>>();
/** A parent's subagent and delegated children. Live changes then arrive as events. */
function loadChildren(parentId: string): Promise<void> {
  const existing = childLoads.get(parentId);
  if (existing) return existing;
  const client = currentClient();
  if (!client) return Promise.resolve();
  const request = client
    .call("threads.list", { parent_thread_id: parentId })
    .then((result) => {
      if (currentClient() !== client) return;
      const children = { ...state.children };
      let changed = false;
      for (const thread of result.threads) {
        if (!isChildThread(thread) || thread.status === "archived") continue;
        const current = children[thread.id];
        if (current && current.last_seq >= thread.last_seq) continue;
        children[thread.id] = thread;
        changed = true;
      }
      if (changed) publish({ children });
    })
    .catch(() => {})
    .finally(() => childLoads.delete(parentId));
  childLoads.set(parentId, request);
  return request;
}

// ---- project order (P2-14) ----

export function setProjectOrder(projectOrder: string[]) {
  publish({ projectOrder });
}
