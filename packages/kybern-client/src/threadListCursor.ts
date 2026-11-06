// The thread list by cursor (#248). The first load is bounded
// (`settled_limit`: active and pinned threads plus the newest settled ones per
// project, with `omitted` counting the rest); afterwards a client asks only for
// rows changed since the last `head_seq` and merges them here, keeping every
// unchanged row object identical so lists don't re-render. A daemon without
// cursors (0.21.6–0.21.8) returns no `head_seq`: its answer is a full list.
import type { ProjectId, Thread, ThreadActivitySummary, ThreadsListParams, ThreadsListResult } from "./types.ts";

/** Settled threads per project on the first load. */
export const FIRST_LIST_SETTLED_LIMIT = 25;
/** Older settled threads fetched by one "Show more". */
export const MORE_THREADS_PAGE = 50;

export interface ThreadListState {
  threads: Thread[];
  activity: ThreadActivitySummary[];
  /** The cursor for the next `since_seq` read; absent when the daemon has no list cursors. */
  headSeq?: number;
  /** Settled threads per project that are not loaded yet. */
  omitted: Record<ProjectId, number>;
  /** Settled threads per project already paged in, the next `settled_offset`. */
  loadedSettled: Record<ProjectId, number>;
}

export const EMPTY_THREAD_LIST: ThreadListState = { threads: [], activity: [], omitted: {}, loadedSettled: {} };

/** Same content: the previous object is kept. `last_seq` and `updated_at` decide fast; the rest is compared whole. */
export function sameThread(a: Thread, b: Thread): boolean {
  if (a === b) return true;
  if (a.id !== b.id || a.last_seq !== b.last_seq || a.updated_at !== b.updated_at) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function sameSummary(a: ThreadActivitySummary, b: ThreadActivitySummary): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** Reuse the previous object of every row that did not change. */
function keepIdentity(previous: readonly Thread[], next: readonly Thread[]): Thread[] {
  const byId = new Map(previous.map((thread) => [thread.id, thread]));
  return next.map((thread) => {
    const old = byId.get(thread.id);
    return old && sameThread(old, thread) ? old : thread;
  });
}

function keepSummaryIdentity(previous: readonly ThreadActivitySummary[], next: readonly ThreadActivitySummary[]) {
  const byId = new Map(previous.map((summary) => [summary.thread_id, summary]));
  return next.map((summary) => {
    const old = byId.get(summary.thread_id);
    return old && sameSummary(old, summary) ? old : summary;
  });
}

function omittedMap(result: ThreadsListResult): Record<ProjectId, number> {
  const map: Record<ProjectId, number> = {};
  for (const entry of result.omitted ?? []) if (entry.count > 0) map[entry.project_id] = entry.count;
  return map;
}

const isArchived = (thread: Thread) => thread.status === "archived";

/** Settled: not pinned, not running or waiting, without activity. The daemon's `settled_limit` counts the same rows. */
function isSettled(thread: Thread, activity: ReadonlyMap<string, ThreadActivitySummary>): boolean {
  return !thread.pinned && thread.status !== "running" && thread.status !== "awaiting-approval" && !activity.has(thread.id);
}

/** Settled rows per project in a list, the `settled_offset` of the next page. */
function settledCounts(threads: readonly Thread[], activity: readonly ThreadActivitySummary[]) {
  const active = new Map(activity.map((summary) => [summary.thread_id, summary]));
  const counts: Record<ProjectId, number> = {};
  for (const thread of threads) if (isSettled(thread, active)) counts[thread.project_id] = (counts[thread.project_id] ?? 0) + 1;
  return counts;
}

/** Whether a client can ask for changed rows only. */
export const hasListCursor = (state: ThreadListState | undefined): state is ThreadListState & { headSeq: number } =>
  state?.headSeq !== undefined;

/** The params of a refresh: changed rows when the daemon has cursors, otherwise the full (bounded) list. */
export function refreshParams(state: ThreadListState | undefined, base: ThreadsListParams = {}): ThreadsListParams {
  if (hasListCursor(state)) return { ...base, since_seq: state.headSeq };
  return { ...base, settled_limit: FIRST_LIST_SETTLED_LIMIT };
}

/** The params of "Show more" for one project. */
export function moreParams(state: ThreadListState, projectId: ProjectId, base: ThreadsListParams = {}): ThreadsListParams {
  return {
    ...base,
    project_id: projectId,
    settled_limit: MORE_THREADS_PAGE,
    settled_offset: state.loadedSettled[projectId] ?? 0,
  };
}

/**
 * Fold a `threads.list` answer into the list. `request` is what was asked: with
 * `since_seq` the answer holds changed rows only; with `settled_offset` it is an
 * older page of one project; otherwise it replaces the list.
 */
export function applyThreadList(
  previous: ThreadListState | undefined,
  request: ThreadsListParams,
  result: ThreadsListResult,
): ThreadListState {
  const prev = previous ?? EMPTY_THREAD_LIST;
  const activity = result.activity ?? [];
  const cursorless = result.head_seq === undefined || result.head_seq === null;

  // A full list: the first load, a daemon without cursors, or a reconnect.
  if (cursorless || (request.since_seq === undefined && request.settled_offset === undefined)) {
    const threads = keepIdentity(prev.threads, result.threads);
    const nextActivity = keepSummaryIdentity(prev.activity, activity);
    return {
      threads,
      activity: nextActivity,
      headSeq: cursorless ? undefined : result.head_seq!,
      omitted: cursorless ? {} : omittedMap(result),
      loadedSettled: cursorless ? {} : settledCounts(threads, nextActivity),
    };
  }

  // An older page of one project: add its rows; the cursor stays (rows outside the page may have changed).
  if (request.since_seq === undefined) {
    const projectId = request.project_id;
    const merged = mergeRows(prev.threads, result.threads, request.include_archived === true);
    const omitted = { ...prev.omitted };
    if (projectId) {
      const left = omittedMap(result)[projectId] ?? 0;
      if (left > 0) omitted[projectId] = left;
      else delete omitted[projectId];
    }
    const loadedSettled = { ...prev.loadedSettled };
    const nextActivity = mergeActivity(prev.activity, result.threads.map((t) => t.id), activity, false);
    const active = new Map(nextActivity.map((summary) => [summary.thread_id, summary]));
    if (projectId)
      loadedSettled[projectId] = (request.settled_offset ?? 0) + result.threads.filter((t) => isSettled(t, active)).length;
    return { threads: merged, activity: nextActivity, headSeq: prev.headSeq, omitted, loadedSettled };
  }

  // Changed rows since the cursor.
  const threads = mergeRows(prev.threads, result.threads, request.include_archived === true);
  const changedIds = new Set(result.threads.map((thread) => thread.id));
  for (const summary of activity) changedIds.add(summary.thread_id);
  const nextActivity = mergeActivity(prev.activity, [...changedIds], activity, true);
  return {
    threads: threads === prev.threads && nextActivity === prev.activity ? prev.threads : threads,
    activity: nextActivity,
    headSeq: Math.max(prev.headSeq ?? 0, result.head_seq!),
    omitted: prev.omitted,
    loadedSettled: prev.loadedSettled,
  };
}

/** Replace or add changed rows in place; archived rows leave a list that hides them. New rows go first. */
function mergeRows(previous: Thread[], changed: readonly Thread[], includeArchived: boolean): Thread[] {
  if (!changed.length) return previous;
  const incoming = new Map(changed.map((thread) => [thread.id, thread]));
  let touched = false;
  const kept: Thread[] = [];
  for (const thread of previous) {
    const next = incoming.get(thread.id);
    if (!next) {
      kept.push(thread);
      continue;
    }
    incoming.delete(thread.id);
    if (isArchived(next) && !includeArchived) {
      touched = true;
      continue;
    }
    if (sameThread(thread, next)) kept.push(thread);
    else {
      kept.push(next);
      touched = true;
    }
  }
  const added = [...incoming.values()].filter((thread) => includeArchived || !isArchived(thread));
  if (added.length) touched = true;
  return touched ? [...added, ...kept] : previous;
}

/** Every thread in `ids` gets the returned summary or none; the others keep theirs. */
function mergeActivity(
  previous: ThreadActivitySummary[],
  ids: readonly string[],
  summaries: readonly ThreadActivitySummary[],
  clearMissing: boolean,
): ThreadActivitySummary[] {
  if (!ids.length && !summaries.length) return previous;
  const replaced = new Set(clearMissing ? ids : summaries.map((summary) => summary.thread_id));
  const byId = new Map(previous.map((summary) => [summary.thread_id, summary]));
  let touched = false;
  const next: ThreadActivitySummary[] = [];
  for (const summary of previous) {
    if (!replaced.has(summary.thread_id)) next.push(summary);
    else touched = true;
  }
  for (const summary of summaries) {
    const old = byId.get(summary.thread_id);
    next.push(old && sameSummary(old, summary) ? old : summary);
    if (!old || !sameSummary(old, summary)) touched = true;
  }
  if (!touched) return previous;
  // Unchanged summaries were removed and re-added: same set means same content.
  if (next.length === previous.length && next.every((summary) => byId.get(summary.thread_id) === summary)) return previous;
  return next;
}
