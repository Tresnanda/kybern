import { EARLIER_HISTORY_ENTRIES } from "../../../../packages/kybern-client/src/historyPaging";
import {
  clientThreadIds,
  createdThreadId,
  createNewChats,
  mergeOptimisticThreads,
  type NewChat,
  type NewChatCreate,
} from "../../../../packages/kybern-client/src/newChat";
import * as SecureStore from "expo-secure-store";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { AppState, Platform } from "react-native";
import { createNativeSocket } from "./nativeSocket";
import { setDraft } from "./draft";
import { applyIndexEvent } from "./indexProjection";
import { ThreadCache } from "./threadCache";
import { attachNotes, loadNotes, resetNotes } from "./notes";
import { attachTasks, loadTasks, resetTasks } from "./tasks";
import { attachRequestProgress } from "./requestProgress";
import { attachPreviews } from "./previews";
import {
  KybernClient,
  PROJECTS_CHANGED_NOTIFICATION,
  httpBase,
  normalizeDaemonUrl,
  type ApprovalRequest,
  type ConnectionStatus,
  type Endpoint,
  type MethodName,
  type ParamsOf,
  type Project,
  type ProjectsChangedNotification,
  type ProviderStatus,
  type QueuedMessage,
  type ResultOf,
  type RuntimeTask,
  type ThreadActivitySummary,
  type Thread,
  type ThreadEvent,
} from "./protocol";
import {
  applyEvent,
  emptyThreadState,
  seedFromGet,
  prependHistory,
  retainHistoryIdentities,
  type ThreadState,
} from "./transcript";

import { versionAtLeast } from "./groups";

export type Environment = Endpoint & { id: string; name: string };
interface State {
  ready: boolean;
  environments: Environment[];
  activeId: string | null;
  status: ConnectionStatus;
  error: string | null;
  projects: Project[];
  threads: Thread[];
  providers: ProviderStatus[];
  approvals: ApprovalRequest[];
  queue: QueuedMessage[];
  activity: ThreadActivitySummary[];
}
/** Counts `projects.changed` notifications, so a slower `projects.list` cannot undo one. */
let projectChanges = 0;
let state: State = {
  ready: false,
  environments: [],
  activeId: null,
  status: "idle",
  error: null,
  projects: [],
  threads: [],
  providers: [],
  approvals: [],
  queue: [],
  activity: [],
};
const listeners = new Set<() => void>();
let client: KybernClient | null = null;
let generation = 0;
export function activeConnectionEpoch() {
  return generation;
}
let subscriptionReady = false;
let indexEvents: ThreadEvent[] | null = null;
let notifyTimer: ReturnType<typeof setTimeout> | undefined;
const changedThreads = new Set<string>();
let activityTimer: ReturnType<typeof setTimeout> | undefined;
let refreshPromise: Promise<void> | null = null;
let providerRefreshPromise: Promise<void> | null = null;
const snapshots = new ThreadCache<ThreadState>();
const empty = emptyThreadState();
const threadListeners = new Map<string, Set<() => void>>();
const hydrating = new Map<string, ThreadEvent[]>();
const loads = new Map<string, Promise<void>>();
const historyLoads = new Map<
  string,
  { events: ThreadEvent[]; promise: Promise<void> }
>();
const RECENT_ENTRIES = 60;
const CACHED_THREADS = 3;
const KEY = "kybern.ink.environments";

export function getState() {
  return state;
}

// ---- hooks for state modules that live beside this one (spaces, attention, settings, usage) ----

type Attach = (client: KybernClient, isCurrent: () => boolean) => void;
const attachHooks = new Set<Attach>();
const readyHooks = new Set<() => void>();
const resetHooks = new Set<() => void>();
const eventHooks = new Set<(event: ThreadEvent) => void>();
const openHooks = new Set<(threadId: string) => void>();
const hook = <F,>(set: Set<F>) => (fn: F) => {
  set.add(fn);
  return () => {
    set.delete(fn);
  };
};
/** A new client for the active computer: subscribe to its notifications here. */
export const onClientAttach = hook(attachHooks);
/** The event subscription is live (first connect and every resume): load lists here. */
export const onSubscriptionReady = hook(readyHooks);
/** The active computer changed or disconnected for good: drop its state. */
export const onEnvironmentReset = hook(resetHooks);
/** Every thread event, the background ones included. */
export const onThreadEvent = hook(eventHooks);
/** A screen started showing this thread. */
export const onThreadOpen = hook(openHooks);
/** True while a screen shows this thread. */
export function isThreadOpen(id: string) {
  return threadListeners.has(id);
}

// ---- optimistic new chats (`packages/kybern-client/src/newChat.ts`) ----

/** New chats started here whose threads the daemon may not have made yet. */
export const newChats = createNewChats({ errorText: (e) => errorText(e) });
/** Ids the daemon's last thread list held: a new chat it does not list yet is shown from its own record. */
let listedThreadIds = new Set<string>();
newChats.subscribe(() => {
  const local = newChats.unlisted().filter((thread) => !listedThreadIds.has(thread.id));
  if (!local.length) return;
  const ids = new Set(local.map((thread) => thread.id));
  publish({ threads: [...local, ...state.threads.filter((thread) => !ids.has(thread.id))] });
});
export function useNewChat(threadId: string | undefined): NewChat | undefined {
  return useSyncExternalStore(newChats.subscribe, () => newChats.get(threadId));
}

/**
 * Start a new chat optimistically: its thread (with the client's id) is listed and opens at once,
 * and `create` makes it on the daemon behind it. Navigate to the thread right after this returns.
 * `seed` puts the first message in the transcript (callers without the send transition's bubble).
 */
export function startNewChat(chat: Omit<NewChat, "state" | "error">, create: NewChatCreate, options: { seed?: boolean } = {}) {
  const at = new Date().toISOString();
  publishThread(chat.threadId, {
    ...emptyThreadState(),
    thread: chat.thread,
    loaded: true,
    blocks: options.seed ? [{ kind: "user", id: chat.messageId, turnId: `pending:${chat.messageId}`, at, seq: 1, message: chat.message }] : [],
  });
  void newChats.start(chat, async (message, messageId) => {
    const result = await create(message, messageId);
    // The daemon has the thread now (under its own id when it ignored ours): its transcript and list entry take over.
    void refresh();
    void loadThread(createdThreadId(result) ?? chat.threadId).catch(() => {});
    return result;
  });
}
function publish(patch: Partial<State>) {
  state = { ...state, ...patch };
  listeners.forEach((fn) => fn());
}
function publishThread(id: string, value: ThreadState) {
  snapshots.set(id, value);
  trimSnapshots();
  changedThreads.add(id);
  // Fold every event, but render at most once per 32ms while an agent streams.
  notifyTimer ??= setTimeout(() => {
    notifyTimer = undefined;
    for (const key of changedThreads)
      threadListeners.get(key)?.forEach((fn) => fn());
    changedThreads.clear();
  }, 32);
}
function trimSnapshots() {
  snapshots.trim(
    CACHED_THREADS,
    (id) => threadListeners.has(id) || loads.has(id) || historyLoads.has(id),
  );
}
export function subscribeApp(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
export function useApp() {
  return useSyncExternalStore(subscribeApp, getState, getState);
}
/** The environment's projects; re-renders only when the list itself changes. */
export function useProjects() {
  const read = () => state.projects;
  return useSyncExternalStore(subscribeApp, read, read);
}
const threadIdentity = (snapshot: ThreadState) => snapshot;
export function useThread(id: string) {
  return useThreadValue(id, threadIdentity);
}
export function useThreadValue<T>(
  id: string,
  select: (snapshot: ThreadState) => T,
) {
  const subscribe = useCallback(
    (fn: () => void) => {
      const set = threadListeners.get(id) ?? new Set();
      set.add(fn);
      threadListeners.set(id, set);
      openHooks.forEach((open) => open(id));
      return () => {
        set.delete(fn);
        if (!set.size) {
          threadListeners.delete(id);
          trimSnapshots();
        }
      };
    },
    [id],
  );
  const getSnapshot = useCallback(
    () => select(snapshots.get(id) ?? empty),
    [id, select],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    if (id && state.status === "open")
      void ensureThread(id).catch((e) => publish({ error: errorText(e) }));
  }, [id, state.status]);
  return snapshot;
}
export function rpc<M extends MethodName>(
  method: M,
  params: ParamsOf<M>,
): Promise<ResultOf<M>> {
  if (!client)
    return Promise.reject(new Error("Connect to your computer to continue."));
  return client.call(method, params);
}
export function activeEnvironment() {
  return state.environments.find((e) => e.id === state.activeId);
}
export function currentClient() {
  return client;
}
/** True when the connected daemon makes the thread the client names (0.15.0 and later). Older
 *  daemons ignore the ids, so new chats there wait for `threads.create` and open its thread. */
export function supportsOptimisticCreate() {
  return clientThreadIds(client?.info?.version);
}
/** True when the connected daemon understands group projects (0.15.0 and later). */
export function supportsGroupProjects() {
  return versionAtLeast(client?.info?.version);
}
export function errorText(e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  if (
    /network request failed|fetch failed|app transport security/i.test(message)
  )
    return "Unable to reach this computer. Check its address and that Kybern is running.";
  if (/abort|timed? ?out/i.test(message))
    return "The computer did not respond. Check your connection and try again.";
  return message;
}
export function clearError() {
  publish({ error: null });
}
async function persist(
  environments = state.environments,
  activeId = state.activeId,
) {
  if (Platform.OS !== "web")
    await SecureStore.setItemAsync(
      KEY,
      JSON.stringify({ environments, activeId }),
      { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY },
    );
}
let booted = false;
export async function boot() {
  if (booted) return;
  booted = true;
  try {
    const raw =
      Platform.OS === "web" ? null : await SecureStore.getItemAsync(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as {
        environments: Environment[];
        activeId: string | null;
      };
      if (Array.isArray(parsed.environments))
        publish({
          environments: parsed.environments.filter(
            (e) =>
              typeof e.id === "string" &&
              typeof e.token === "string" &&
              typeof e.url === "string",
          ),
          activeId: parsed.activeId,
        });
    }
    publish({ ready: true });
    if (state.activeId) connect(state.activeId);
  } catch {
    publish({
      ready: true,
      error: "Unable to read saved connections. Add your computer again.",
    });
  }
  AppState.addEventListener("change", (next) => {
    if (next === "active") void client?.checkConnection();
  });
}
export async function addEnvironment(endpoint: Endpoint, name: string) {
  // Verify identity and credential before saving or replacing the active connection.
  const candidate = new KybernClient(
    { ...endpoint, url: normalizeDaemonUrl(endpoint.url) },
    {
      createSocket: Platform.OS === "web" ? undefined : createNativeSocket,
    },
  );
  const info = await new Promise<NonNullable<KybernClient["info"]>>(
    (resolve, reject) => {
      const timer = setTimeout(() => {
        candidate.close();
        reject(
          new Error(
            "Connection timed out. Check the address and that Kybern is running.",
          ),
        );
      }, 16000);
      candidate.onStatus((status, detail) => {
        if (status === "open" && candidate.info) {
          clearTimeout(timer);
          resolve(candidate.info);
        }
        if (status === "failed") {
          clearTimeout(timer);
          reject(new Error(detail));
        }
      });
      candidate.connect();
    },
  ).finally(() => candidate.close());
  const environment: Environment = {
    ...endpoint,
    url: normalizeDaemonUrl(endpoint.url),
    environmentId: info.environment_id,
    id: info.environment_id,
    name: name.trim() || info.hostname,
  };
  await saveEnvironment(environment);
  connect(environment.id);
}
async function saveEnvironment(environment: Environment) {
  const environments = [
    ...state.environments.filter((e) => e.id !== environment.id),
    environment,
  ];
  await persist(environments);
  publish({ environments });
}
export async function pairEnvironment(
  url: string,
  code: string,
  name: string,
  expectedId?: string,
) {
  const address = normalizeDaemonUrl(url);
  const response = await fetch(`${httpBase(address)}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: code.trim(), device_name: "Kybern mobile" }),
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  });
  if (!response.ok)
    throw new Error(
      "Pairing expired or the code is incorrect. Create a new invitation on your computer.",
    );
  const result = (await response.json()) as {
    token: string;
    environment_id: string;
  };
  if (
    !result.token ||
    !result.environment_id ||
    (expectedId && expectedId !== result.environment_id)
  )
    throw new Error(
      "This invitation does not match the computer. Create a new invitation.",
    );
  const endpoint = {
    url: address,
    token: result.token,
    environmentId: result.environment_id,
  };
  // Redemption consumes the one-time code. Keep the issued credential even if
  // the following socket handshake fails, so Settings can retry it safely.
  await saveEnvironment({
    ...endpoint,
    id: result.environment_id,
    name: name.trim() || new URL(address).hostname,
  });
  try {
    await addEnvironment(endpoint, name);
  } catch {
    throw new Error(
      "Pairing was saved, but the live connection could not open. Open Settings → Computers to reconnect without another code.",
    );
  }
}
export async function removeEnvironment(id: string) {
  const environments = state.environments.filter((e) => e.id !== id);
  const active =
    state.activeId === id ? (environments[0]?.id ?? null) : state.activeId;
  await persist(environments, active);
  publish({ environments });
  if (state.activeId === id) connect(active);
}
export function connect(id: string | null) {
  generation++;
  clearTimeout(activityTimer);
  activityTimer = undefined;
  subscriptionReady = false;
  clearTimeout(notifyTimer);
  notifyTimer = undefined;
  changedThreads.clear();
  indexEvents = null;
  refreshPromise = null;
  providerRefreshPromise = null;
  client?.close();
  client = null;
  snapshots.cancelReplay();
  resetNotes();
  resetTasks();
  if (state.activeId !== id) resetHooks.forEach((reset) => reset());
  if (state.activeId === id) snapshots.invalidateAll();
  else {
    snapshots.clear();
    newChats.clear();
  }
  loads.clear();
  historyLoads.clear();
  hydrating.clear();
  threadListeners.forEach((set) => set.forEach((fn) => fn()));
  publish({
    activeId: id,
    status: "idle",
    error: null,
    projects: [],
    threads: [],
    providers: [],
    approvals: [],
    queue: [],
    activity: [],
  });
  void persist().catch((e) => publish({ error: errorText(e) }));
  const env = state.environments.find((e) => e.id === id);
  if (!env) return;
  const thisGeneration = generation;
  let appliedDefaults = false;
  const next = new KybernClient(env, {
    createSocket: Platform.OS === "web" ? undefined : createNativeSocket,
  });
  client = next;
  attachNotes(next, () => generation === thisGeneration);
  attachTasks(next, () => generation === thisGeneration);
  attachRequestProgress(next, () => generation === thisGeneration);
  attachHooks.forEach((attach) => attach(next, () => generation === thisGeneration && client === next));
  attachPreviews(next, () => generation === thisGeneration);
  // Projects added or removed elsewhere (desktop, CLI) arrive as the whole list.
  next.onNotification(PROJECTS_CHANGED_NOTIFICATION, (params) => {
    if (generation !== thisGeneration || client !== next) return;
    const projects = (params as ProjectsChangedNotification | null)?.projects;
    if (!Array.isArray(projects)) return;
    projectChanges++;
    publish({ projects });
  });
  next.onStatus((status, detail) => {
    if (generation !== thisGeneration) return;
    publish({ status, error: status === "open" ? null : (detail ?? null) });
    if (status !== "open") {
      subscriptionReady = false;
      // Only a completed replay may validate a snapshot after a disconnect.
      snapshots.beginReplay();
    }
  });
  next.subscribeEvents(
    {},
    (event) => {
      if (generation !== thisGeneration) return;
      hydrating.get(event.thread_id)?.push(event);
      historyLoads.get(event.thread_id)?.events.push(event);
      const snapshot = snapshots.get(event.thread_id);
      if (
        snapshot?.loaded &&
        (!snapshots.isStale(event.thread_id) || snapshots.canReplay(event.thread_id))
      )
        publishThread(event.thread_id, applyEvent(snapshot, event));
      else if (snapshot && !hydrating.has(event.thread_id))
        snapshots.invalidate(event.thread_id);
      if (
        event.kind === "runtime_task_started" ||
        event.kind === "runtime_task_updated" ||
        event.kind === "runtime_task_completed" ||
        // A request raised or answered anywhere changes which rows say "Needs input".
        event.kind === "approval_requested" ||
        event.kind === "user_input_requested" ||
        event.kind === "approval_resolved"
      ) {
        clearTimeout(activityTimer);
        activityTimer = setTimeout(() => {
          void next
            .call("threads.list", { include_archived: true })
            .then((result) => {
              if (generation === thisGeneration)
                publish({ activity: result.activity ?? [] });
            })
            .catch(() => {});
        }, 150);
      }
      eventHooks.forEach((tap) => tap(event));
      if (indexEvents) indexEvents.push(event);
      const nextIndex = applyIndexEvent(state, event);
      if (nextIndex !== state) publish(nextIndex);
      if (event.kind === "workspace_reverted") {
        snapshots.invalidate(event.thread_id);
        if (threadListeners.has(event.thread_id))
          void loadThread(event.thread_id).catch((e) => publish({ error: errorText(e) }));
      }
    },
    (_headSeq, replay) => {
      if (generation !== thisGeneration) return;
      if (replay.resumed && replay.supported) {
        subscriptionReady = false;
        snapshots.beginReplay();
        return;
      }
      // Initial connections and older daemons use the snapshot/replay fallback.
      snapshots.cancelReplay();
      snapshots.invalidateAll();
      subscriptionReady = true;
      if (!appliedDefaults) {
        appliedDefaults = true;
        void next
          .call("settings.get", {})
          .then((settings) => {
            if (generation === thisGeneration)
              setDraft({
                projectId: "",
                provider: settings.default_provider,
                instance: "default",
                model:
                  settings.providers[settings.default_provider]?.model ?? "",
                effort: "",
                permission: settings.default_permission_mode,
                worktree: settings.worktrees_default,
                baseBranch: "",
              });
          })
          .catch(() => {});
      }
      void refresh().catch((e) => {
        if (generation === thisGeneration) publish({ error: errorText(e) });
      });
      void loadNotes();
      void loadTasks();
      readyHooks.forEach((ready) => ready());
      for (const id of threadListeners.keys())
        if (id)
          void loadThread(id).catch((e) => {
            if (generation === thisGeneration) publish({ error: errorText(e) });
          });
    },
    (_headSeq, resumed) => {
      if (generation !== thisGeneration || !resumed) return;
      snapshots.finishReplay();
      subscriptionReady = true;
      void refresh().catch((e) => {
        if (generation === thisGeneration) publish({ error: errorText(e) });
      });
      void loadNotes();
      void loadTasks();
      readyHooks.forEach((ready) => ready());
      for (const id of threadListeners.keys())
        if (id) void ensureThread(id).catch((e) => {
          if (generation === thisGeneration) publish({ error: errorText(e) });
        });
    },
  );
  next.connect();
}
export async function refresh() {
  if (!subscriptionReady) return;
  if (refreshPromise) return refreshPromise;
  const epoch = generation;
  // Provider probing can start external processes; never gate the workspace on it.
  if (!providerRefreshPromise) {
    providerRefreshPromise = rpc("providers.list", {}).then((result) => {
      if (epoch === generation) publish({ providers: result.providers });
    }).catch((e) => {
      if (epoch === generation) publish({ error: errorText(e) });
    }).finally(() => {
      if (epoch === generation) providerRefreshPromise = null;
    });
  }
  const events: ThreadEvent[] = [];
  indexEvents = events;
  const projectsSeen = projectChanges;
  refreshPromise = (async () => {
    const [projects, threads, approvals, queue] = await Promise.all([
      rpc("projects.list", {}),
      rpc("threads.list", { include_archived: true }),
      rpc("approvals.list", {}),
      rpc("queue.list", {}),
    ]);
    if (epoch === generation) {
      let next: State = {
        ...state,
        // A `projects.changed` received meanwhile is newer than this list.
        projects: projectChanges === projectsSeen ? projects.projects : state.projects,
        threads: withNewChats(threads.threads),
        approvals: approvals.approvals,
        queue: queue.messages,
        activity: threads.activity ?? [],
        error: null,
      };
      for (const event of events) next = applyIndexEvent(next, event);
      publish(next);
    }
  })().finally(() => {
    if (epoch === generation) {
      refreshPromise = null;
      indexEvents = null;
    }
  });
  return refreshPromise;
}
function withNewChats(listed: Thread[]): Thread[] {
  listedThreadIds = new Set(listed.map((thread) => thread.id));
  const merged = mergeOptimisticThreads(listed, newChats.unlisted());
  if (merged.listed.length) queueMicrotask(() => newChats.listed(merged.listed));
  return merged.threads;
}
export async function loadThread(id: string) {
  if (!id || !subscriptionReady) return;
  if (loads.has(id)) return loads.get(id)!;
  historyLoads.delete(id);
  const epoch = generation;
  const revision = snapshots.revision(id);
  let superseded = false;
  const buffer: ThreadEvent[] = [];
  hydrating.set(id, buffer);
  const previous = snapshots.get(id);
  // Reconnects retain already loaded history. Large, fully browsed threads use
  // the legacy full snapshot instead of dropping the user's reading position.
  const requested = Math.max(RECENT_ENTRIES, previous?.blocks.length ?? 0);
  const request = rpc("threads.get", {
    thread_id: id,
    // Settled tool output streams load when a step is opened (`threads.tool_output`).
    defer_tool_stream: true,
    ...(requested <= 500 ? { transcript_limit: requested } : {}),
  })
    .then((result) => {
      if (epoch !== generation) return;
      let snapshot = seedFromGet(result);
      for (const event of buffer) snapshot = applyEvent(snapshot, event);
      if (previous)
        snapshot = retainHistoryIdentities(
          snapshot,
          snapshots.get(id) ?? previous,
        );
      publishThread(id, snapshot);
      superseded = !snapshots.markFresh(id, revision);
    })
    .finally(() => {
      if (epoch === generation) {
        loads.delete(id);
        hydrating.delete(id);
        trimSnapshots();
        // A reconnect may have acknowledged a new subscription while this old
        // request was pending. Catch up once more without clearing visible rows.
        if (superseded && subscriptionReady && threadListeners.has(id))
          void ensureThread(id).catch((e) => publish({ error: errorText(e) }));
      }
    });
  loads.set(id, request);
  return request;
}
export async function ensureThread(id: string) {
  // A new chat the daemon has not made yet: its seeded record stands until the create answers.
  if (newChats.uncreated(id)) return;
  snapshots.touch(id);
  if (!snapshots.get(id)?.loaded || snapshots.isStale(id)) await loadThread(id);
}

export async function loadEarlier(id: string) {
  const existing = historyLoads.get(id);
  if (existing) return existing.promise;
  const base = snapshots.get(id);
  if (
    !subscriptionReady ||
    !base?.loaded ||
    base.nextBeforeSeq === null ||
    loads.has(id)
  )
    return;
  const epoch = generation;
  const record = { events: [] as ThreadEvent[], promise: Promise.resolve() };
  historyLoads.set(id, record);
  publishThread(id, { ...base, loadingEarlier: true });
  record.promise = rpc("threads.get", {
    thread_id: id,
    defer_tool_stream: true,
    transcript_limit: EARLIER_HISTORY_ENTRIES,
    before_seq: base.nextBeforeSeq,
    through_seq: base.lastSeq,
  })
    .then((page) => {
      if (epoch !== generation || historyLoads.get(id) !== record) return;
      const current = snapshots.get(id);
      if (!current) return;
      publishThread(
        id,
        retainHistoryIdentities(
          prependHistory(base, page, record.events),
          current,
        ),
      );
    })
    .finally(() => {
      if (epoch !== generation || historyLoads.get(id) !== record) return;
      historyLoads.delete(id);
      const current = snapshots.get(id);
      if (current?.loadingEarlier)
        publishThread(id, { ...current, loadingEarlier: false });
    });
  return record.promise;
}
export async function mutate<M extends MethodName>(
  method: M,
  params: ParamsOf<M>,
) {
  const result = await rpc(method, params);
  await refresh();
  return result;
}
export function assetUrl(id: string) {
  const env = activeEnvironment();
  return env ? `${httpBase(env.url)}/assets/${encodeURIComponent(id)}` : "";
}
export function taskActive(task: RuntimeTask) {
  return ["pending", "running", "waiting", "stopping"].includes(task.status);
}

/** Foreground completion does not mean provider-owned background work stopped. */
export function threadHasActivity(
  thread: Thread,
  activity: ThreadActivitySummary[],
) {
  return (
    thread.status === "running" ||
    thread.status === "awaiting-approval" ||
    activity.some(
      (a) =>
        a.thread_id === thread.id &&
        a.active_agents + a.active_processes + a.active_monitors > 0,
    )
  );
}
