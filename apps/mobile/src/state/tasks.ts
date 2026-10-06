// Tasks for the connected computer. The runtime attaches the live client on
// every connection: the list loads once the subscription is ready, again after
// each reconnect, and `tasks.items.changed` notifications keep it current in
// between (including run status, which the daemon owns). Status, priority and
// checklist changes show at once and roll back if the computer refuses them.
import { useCallback, useSyncExternalStore } from "react";
import {
  TASK_ITEMS_CHANGED_NOTIFICATION,
  type KybernClient,
  type TaskItem,
  type TaskItemsChangedNotification,
  type TaskItemsSendParams,
  type TaskPriority,
  type TaskStatus,
} from "./protocol";
import {
  METHOD_NOT_FOUND,
  TOAST_MS,
  UNDO_MS,
  applyTaskChange,
  toggleCriterion,
  withOverrides,
  type TaskOverride,
} from "./tasksModel";

/** A short notice at the bottom of Tasks: "ADE-14 started · Open", "Task deleted · Undo". */
export interface TaskToast {
  id: number;
  text: string;
  action?:
    | { kind: "undo"; taskId: string }
    | { kind: "open"; threadId: string };
}

export interface TasksState {
  tasks: TaskItem[];
  loaded: boolean;
  /** The computer's daemon predates tasks. */
  unsupported: boolean;
  error: string;
  toast: TaskToast | null;
}
const initial: TasksState = {
  tasks: [],
  loaded: false,
  unsupported: false,
  error: "",
  toast: null,
};
let state = initial;
let server: TaskItem[] = [];
let overrides: Record<string, TaskOverride> = {};
const tokens = new Map<string, number>();
const listeners = new Set<() => void>();
let client: KybernClient | null = null;
let isCurrent: () => boolean = () => false;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let toastSeq = 0;
let loading: Promise<void> | null = null;

function publish(patch: Partial<TasksState> = {}) {
  state = { ...state, ...patch, tasks: withOverrides(server, overrides) };
  listeners.forEach((fn) => fn());
}
const getState = () => state;
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

export function getTasks() {
  return state;
}
export function useTasks() {
  return useSyncExternalStore(subscribe, getState, getState);
}
/** One task, live. Re-renders only when that task (or its pending change) changes. */
export function useTask(id: string | undefined) {
  const get = useCallback(
    () => (id ? state.tasks.find((task) => task.id === id) : undefined),
    [id],
  );
  return useSyncExternalStore(subscribe, get, get);
}

/** Whether the list has been read, so a missing task really is gone. */
export function useTasksKnown() {
  const get = useCallback(() => state.loaded && !state.unsupported, []);
  return useSyncExternalStore(subscribe, get, get);
}

/** Called when the active computer changes: tasks never leak across computers. */
export function resetTasks() {
  clearTimeout(toastTimer);
  toastTimer = undefined;
  client = null;
  isCurrent = () => false;
  loading = null;
  server = [];
  overrides = {};
  tokens.clear();
  state = { ...initial };
  listeners.forEach((fn) => fn());
}

export function attachTasks(next: KybernClient, current: () => boolean) {
  client = next;
  isCurrent = current;
  next.onNotification(TASK_ITEMS_CHANGED_NOTIFICATION, (params) => {
    if (!current() || client !== next || !params || typeof params !== "object")
      return;
    fold(params as TaskItemsChangedNotification);
  });
}

function fold(change: TaskItemsChangedNotification) {
  server = applyTaskChange(server, change);
  publish();
}

function failure(e: unknown) {
  const code = (e as { code?: number } | null)?.code;
  if (code === METHOD_NOT_FOUND) return { unsupported: true, error: "" };
  return {
    unsupported: false,
    error: e instanceof Error ? e.message : String(e),
  };
}

/** Loads the full list. Safe to call repeatedly; overlapping calls share one request. */
export function loadTasks() {
  const active = client;
  if (!active) return Promise.resolve();
  if (loading) return loading;
  const request = active
    .call("tasks.items.list", {})
    .then((result) => {
      if (client !== active || !isCurrent()) return;
      server = result.tasks ?? [];
      publish({ loaded: true, unsupported: false, error: "" });
    })
    .catch((e) => {
      if (client !== active || !isCurrent()) return;
      publish({ loaded: true, ...failure(e) });
    })
    .finally(() => {
      if (loading === request) loading = null;
    });
  loading = request;
  return request;
}

function need() {
  if (!client) throw new Error("Connect to your computer to continue.");
  return client;
}
function confirmed(task: TaskItem) {
  fold({ task });
  return task;
}

/**
 * Show a change immediately, then confirm it with the computer. A newer change
 * to the same task supersedes an older one still in flight; a refusal restores
 * what the computer last said.
 */
async function optimistic(
  id: string,
  patch: TaskOverride,
  send: () => Promise<TaskItem>,
) {
  const token = (tokens.get(id) ?? 0) + 1;
  tokens.set(id, token);
  overrides = { ...overrides, [id]: { ...overrides[id], ...patch } };
  publish();
  const settle = () => {
    if (tokens.get(id) !== token) return;
    tokens.delete(id);
    const { [id]: _, ...rest } = overrides;
    overrides = rest;
  };
  try {
    const task = await send();
    settle();
    return confirmed(task);
  } catch (e) {
    settle();
    publish();
    throw e;
  }
}

export async function createTask(input: {
  title: string;
  projectId?: string | null;
  status?: TaskStatus;
  priority?: TaskPriority;
  body?: string;
}) {
  const task = await need().call("tasks.items.create", {
    scope: input.projectId ? "project" : "global",
    project_id: input.projectId ?? null,
    title: input.title.trim(),
    ...(input.body ? { body: input.body } : {}),
    status: input.status ?? "inbox",
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
  });
  return confirmed(task);
}

export function setTaskStatus(id: string, status: TaskStatus) {
  const c = need();
  return optimistic(id, { status }, () =>
    c.call("tasks.items.update", { id, status }),
  );
}
export function setTaskPriority(id: string, priority: TaskPriority) {
  const c = need();
  return optimistic(id, { priority }, () =>
    c.call("tasks.items.update", { id, priority }),
  );
}

/** Tick or untick one acceptance criterion. */
export function toggleTaskCriterion(id: string, index: number) {
  const c = need();
  const task = state.tasks.find((t) => t.id === id);
  if (!task) return Promise.reject(new Error("This task is no longer here."));
  const body = toggleCriterion(task.body, index);
  return optimistic(id, { body }, () =>
    c.call("tasks.items.update", {
      id,
      body,
      expected_revision: task.revision,
    }),
  );
}

/** Saves edited text. A CONFLICT error means someone else changed it first. */
export async function saveTaskText(
  id: string,
  input: { title: string; body: string },
  expectedRevision: number,
) {
  return confirmed(
    await need().call("tasks.items.update", {
      id,
      title: input.title,
      body: input.body,
      expected_revision: expectedRevision,
    }),
  );
}

export async function setTaskNotes(id: string, noteIds: string[]) {
  return confirmed(
    await need().call("tasks.items.update", { id, note_ids: noteIds }),
  );
}
export async function clearPendingFollowup(id: string) {
  return confirmed(
    await need().call("tasks.items.update", { id, pending_followup: "" }),
  );
}

export async function fetchTask(id: string) {
  const { task } = await need().call("tasks.items.get", { id });
  if (task) confirmed(task);
  return task ?? null;
}

export async function deleteTask(id: string) {
  const task = state.tasks.find((t) => t.id === id);
  await need().call("tasks.items.delete", { id });
  fold({ deleted_id: id });
  showToast(`${task?.key ?? "Task"} deleted`, { kind: "undo", taskId: id }, UNDO_MS);
}
export async function restoreTask(id: string) {
  dismissToast();
  return confirmed(await need().call("tasks.items.restore", { id }));
}

export async function sendTask(params: TaskItemsSendParams) {
  const result = await need().call("tasks.items.send", params);
  confirmed(result.task);
  return result;
}

/** Sends to the latest run's idle thread, queues behind a running one, or saves for the next run. */
export async function followupTask(id: string, text: string) {
  const result = await need().call("tasks.items.followup", { id, text });
  confirmed(result.task);
  return result;
}

export function showToast(
  text: string,
  action?: TaskToast["action"],
  ms = TOAST_MS,
) {
  clearTimeout(toastTimer);
  publish({ toast: { id: ++toastSeq, text, action } });
  toastTimer = setTimeout(dismissToast, ms);
}
export function dismissToast() {
  clearTimeout(toastTimer);
  toastTimer = undefined;
  if (state.toast) publish({ toast: null });
}
