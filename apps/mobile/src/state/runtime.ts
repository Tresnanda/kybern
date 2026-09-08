import * as SecureStore from "expo-secure-store";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { AppState, Platform } from "react-native";
import { setDraft } from "./draft";
import { applyIndexEvent } from "./indexProjection";
import {
  KybernClient,
  httpBase,
  normalizeDaemonUrl,
  type ApprovalRequest,
  type ConnectionStatus,
  type Endpoint,
  type MethodName,
  type ParamsOf,
  type Project,
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
  type ThreadState,
} from "./transcript";

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
let subscriptionReady = false;
let indexEvents: ThreadEvent[] | null = null;
let notifyTimer: ReturnType<typeof setTimeout> | undefined;
const changedThreads = new Set<string>();
let activityTimer: ReturnType<typeof setTimeout> | undefined;
let refreshPromise: Promise<void> | null = null;
const snapshots = new Map<string, ThreadState>();
const empty = emptyThreadState();
const threadListeners = new Map<string, Set<() => void>>();
const hydrating = new Map<string, ThreadEvent[]>();
const loads = new Map<string, Promise<void>>();
const KEY = "kybern.ink.environments";

export function getState() {
  return state;
}
function publish(patch: Partial<State>) {
  state = { ...state, ...patch };
  listeners.forEach((fn) => fn());
}
function publishThread(id: string, value: ThreadState) {
  snapshots.set(id, value);
  changedThreads.add(id);
  // Fold every event, but render at most once per 32ms while an agent streams.
  notifyTimer ??= setTimeout(() => {
    notifyTimer = undefined;
    for (const key of changedThreads)
      threadListeners.get(key)?.forEach((fn) => fn());
    changedThreads.clear();
  }, 32);
}
export function useApp() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    getState,
    getState,
  );
}
export function useThread(id: string) {
  const subscribe = useCallback(
    (fn: () => void) => {
      const set = threadListeners.get(id) ?? new Set();
      set.add(fn);
      threadListeners.set(id, set);
      return () => {
        set.delete(fn);
        if (!set.size) {
          threadListeners.delete(id);
          snapshots.delete(id);
        }
      };
    },
    [id],
  );
  const getSnapshot = useCallback(() => snapshots.get(id) ?? empty, [id]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => empty);
  useEffect(() => {
    if (id && state.status === "open")
      void loadThread(id).catch((e) => publish({ error: errorText(e) }));
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
  const candidate = new KybernClient(endpoint);
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
  const environments = [
    ...state.environments.filter((e) => e.id !== environment.id),
    environment,
  ];
  await persist(environments, environment.id);
  publish({ environments });
  connect(environment.id);
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
  await addEnvironment(
    { url: address, token: result.token, environmentId: result.environment_id },
    name,
  );
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
  client?.close();
  client = null;
  snapshots.clear();
  loads.clear();
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
  const next = new KybernClient(env);
  client = next;
  next.onStatus((status, detail) => {
    if (generation !== thisGeneration) return;
    publish({ status, error: status === "open" ? null : (detail ?? null) });
    if (status !== "open") subscriptionReady = false;
  });
  next.subscribeEvents(
    {},
    (event) => {
      if (generation !== thisGeneration) return;
      hydrating.get(event.thread_id)?.push(event);
      const snapshot = snapshots.get(event.thread_id);
      if (snapshot?.loaded)
        publishThread(event.thread_id, applyEvent(snapshot, event));
      if (
        event.kind === "runtime_task_started" ||
        event.kind === "runtime_task_updated" ||
        event.kind === "runtime_task_completed"
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
      if (indexEvents) indexEvents.push(event);
      const nextIndex = applyIndexEvent(state, event);
      if (nextIndex !== state) publish(nextIndex);
      if (
        event.kind === "workspace_reverted" &&
        threadListeners.has(event.thread_id)
      )
        void loadThread(event.thread_id).catch((e) =>
          publish({ error: errorText(e) }),
        );
    },
    () => {
      if (generation !== thisGeneration) return;
      // Hydrate only after the live subscription is acknowledged, closing the
      // snapshot/subscription race on initial connection and reconnect.
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
      for (const id of threadListeners.keys())
        if (id)
          void loadThread(id).catch((e) => {
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
  const events: ThreadEvent[] = [];
  indexEvents = events;
  refreshPromise = (async () => {
    const [projects, threads, providers, approvals, queue] = await Promise.all([
      rpc("projects.list", {}),
      rpc("threads.list", { include_archived: true }),
      rpc("providers.list", {}),
      rpc("approvals.list", {}),
      rpc("queue.list", {}),
    ]);
    if (epoch === generation) {
      let next: State = {
        ...state,
        projects: projects.projects,
        threads: threads.threads,
        providers: providers.providers,
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
export async function loadThread(id: string) {
  if (!id || !subscriptionReady) return;
  if (loads.has(id)) return loads.get(id)!;
  const epoch = generation;
  const buffer: ThreadEvent[] = [];
  hydrating.set(id, buffer);
  const request = rpc("threads.get", { thread_id: id })
    .then((result) => {
      if (epoch !== generation) return;
      let snapshot = seedFromGet(result);
      for (const event of buffer) snapshot = applyEvent(snapshot, event);
      publishThread(id, snapshot);
    })
    .finally(() => {
      if (epoch === generation) {
        loads.delete(id);
        hydrating.delete(id);
      }
    });
  loads.set(id, request);
  return request;
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
