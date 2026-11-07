import { EARLIER_HISTORY_ENTRIES, FIRST_PAGE_BUDGET } from "../../../../packages/kybern-client/src/historyPaging";
import { applyThreadList, hasListCursor, moreParams, refreshParams, type ThreadListState } from "../../../../packages/kybern-client/src/threadListCursor";
import { createLinger, createPrefetchQueue, PREFETCH_TOP_ROWS } from "../../../../packages/kybern-client/src/threadWarmth";
import type { TranscriptCache, TranscriptCacheStore } from "../../../../packages/kybern-client/src/transcriptCache";
import { createTranscriptDisk, defaultTranscriptStore, savedThread, type CachedThread } from "./transcriptDisk";
import { listCache, setListCacheStorage } from "./listCache";
import { setNetworkRouting } from "./federated";
import { fileStorage } from "./listCacheFile";
import {
  clientThreadIds,
  createdThreadId,
  isQueuedCreate,
  createNewChats,
  mergeOptimisticThreads,
  type NewChat,
  type NewChatCreate,
} from "../../../../packages/kybern-client/src/newChat";
import * as SecureStore from "expo-secure-store";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { AppState, Platform } from "react-native";
import { createNativeSocket } from "./nativeSocket";
import { getRandomValues, randomUUID } from "expo-crypto";
import { ItemCache } from "../../../../packages/kybern-client/src/itemCache";
import { defaultTranscriptStore as itemStore } from "./transcriptDisk";
import { MachineCache } from "../../../../packages/kybern-client/src/machineCache";
import { MachineHub } from "../machines/hub";
import { machineCacheFile } from "../machines/cacheFile";
import { computerOfRecord, routeUrl } from "../machines/records";
import {
  deviceId as loadDeviceId,
  loadMachines,
  machineCredentials,
  machineStore,
  saveActive,
  type KeyValue,
} from "../machines/storage";
import { buildLists, cachedSingleLists, singleMachineLists, type ListsView } from "./machineLists";
import type { MachineId } from "./protocol";
import { setDraft } from "./draft";
import { contextOf, prProblemModel, problemModel, sentenceOf, type PhoneContext, type ProblemModel } from "./problems";
import { markListShown } from "./devTiming";
import { applyIndexEvent } from "./indexProjection";
import { ThreadCache } from "./threadCache";
import { attachNotes, loadNotes, resetNotes } from "./notes";
import { attachTasks, loadTasks, resetTasks } from "./tasks";
import { attachRequestProgress } from "./requestProgress";
import { attachPreviews } from "./previewRequests";
import {
  KybernClient,
  PROJECTS_CHANGED_NOTIFICATION,
  httpBase,
  normalizeDaemonUrl,
  type ApprovalDecision,
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
import { shouldTryOtherAddresses } from "./addressFailover";

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
  /** Settled threads per project the computer did not list yet ("Show more" pages them in). */
  omitted: Record<string, number>;
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
  omitted: {},
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
/** Transcripts kept in memory: the open ones plus the most recently visited, within a byte budget (#248). */
const CACHED_THREADS = 12;
const CACHED_BYTES = 16 * 1024 * 1024;

// ---- the disk copy of opened transcripts (`transcriptDisk.ts`, #248) ----

let diskStore: TranscriptCacheStore | undefined | null = null;
let disk: TranscriptCache<CachedThread> | undefined;
/** The disk cache, made on first use; none where the platform has no SQLite. */
function transcriptDisk(): TranscriptCache<CachedThread> | undefined {
  if (diskStore === null) diskStore = defaultTranscriptStore();
  if (!disk && diskStore) disk = createTranscriptDisk(diskStore);
  return disk;
}
/** Tests: use this store for the disk cache (a fresh cache over it). */
export function setTranscriptStore(store: TranscriptCacheStore | undefined) {
  diskStore = store;
  disk = undefined;
}
/** The `lastSeq` each thread was saved or restored at in this session, so prefetch can skip it. */
const diskSeqs = new Map<string, number>();
/** Threads whose shown copy came from the disk and has not caught up yet. */
const restored = new Set<string>();
const restores = new Map<string, Promise<void>>();
/** Machines whose daemon resumes a thread from a cursor with a gap snapshot (it answered `as_of_seq`). */
const resumable = new Set<string>();
/** The machine a thread's disk record is filed under: its own, else the computer the phone is at. */
function cacheMachine(threadId: string): MachineId | undefined {
  return remoteOwner(threadId) ?? hub?.primaryMachineId;
}
const cacheKey = (machineId: string, threadId: string) => `${machineId}\u0000${threadId}`;
/** Save a thread behind, once its shown state is complete (loaded, caught up, not a new chat still being made). */
function scheduleSave(id: string) {
  const machineId = cacheMachine(id);
  const cache = transcriptDisk();
  if (!machineId || !cache) return;
  cache.schedule(machineId, id, () => {
    const current = snapshots.get(id);
    if (!current?.loaded || !current.thread || snapshots.isStale(id) || hydrating.has(id) || restored.has(id) || newChats.uncreated(id)) return undefined;
    diskSeqs.set(cacheKey(machineId, id), current.lastSeq);
    return { lastSeq: current.lastSeq, data: savedThread(current) };
  });
}
/**
 * Show a thread's disk copy at once when memory has none: marked stale, so live events wait
 * for the catch-up (`resumeThread`) instead of landing after a gap. Works offline too.
 */
function restoreThread(id: string): Promise<void> {
  if (!id || snapshots.get(id)?.loaded || newChats.uncreated(id)) return Promise.resolve();
  const running = restores.get(id);
  if (running) return running;
  const machineId = cacheMachine(id);
  const cache = transcriptDisk();
  if (!machineId || !cache) return Promise.resolve();
  const epoch = generation;
  const request = cache
    .load(machineId, id)
    .then((cached) => {
      if (!cached || epoch !== generation || snapshots.get(id)?.loaded) return;
      diskSeqs.set(cacheKey(machineId, id), cached.lastSeq);
      restored.add(id);
      publishThread(id, { ...emptyThreadState(), ...cached.data, lastSeq: cached.lastSeq, loaded: true, loadingEarlier: false });
      // A rough size for the memory budget (rows of a page average about 1.5 KB); the catch-up replaces it.
      snapshots.setSize(id, cached.data.blocks.length * 1536);
      snapshots.invalidate(id);
    })
    .catch(() => {})
    .finally(() => restores.delete(id));
  restores.set(id, request);
  return request;
}

// ---- keeping threads warm (`threadWarmth.ts`, #248) ----

/** A closed thread stays in memory, followed by the event stream, for five minutes before it may be evicted. */
const linger = createLinger({ expire: () => trimSnapshots() });
/** First pages of the threads at the top of a list, fetched ahead of a tap. */
const prefetch = createPrefetchQueue({
  run: (id) => loadThread(id, { prefetch: true }),
  skip: (id) => {
    if (threadListeners.has(id) || loads.has(id) || newChats.uncreated(id)) return true;
    if (!threadConnection(id).open) return true;
    const listed = listedThread(id);
    const current = snapshots.get(id);
    if (current?.loaded && !snapshots.isStale(id) && (!listed || current.lastSeq >= listed.last_seq)) return true;
    const machineId = cacheMachine(id);
    const saved = machineId ? diskSeqs.get(cacheKey(machineId, id)) : undefined;
    return saved !== undefined && !!listed && saved >= listed.last_seq;
  },
});
function listedThread(id: string): Thread | undefined {
  return state.threads.find((thread) => thread.id === id) ?? hub?.view().threads.all.find((entry) => entry.thread.id === id)?.thread;
}
/** The rows at the top of a thread list: their first pages load ahead of a tap (bounded, two at a time). */
export function prefetchThreads(threads: readonly Pick<Thread, "id">[]) {
  prefetch.want(threads.slice(0, PREFETCH_TOP_ROWS).map((thread) => thread.id));
}
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
export const newChats = createNewChats({ errorText: (e) => errorText(e, "start the chat") });
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
    // Queued for a machine that is away: it waits in the outbox, and `state/outbox.ts` loads the thread once the machine has it.
    if (isQueuedCreate(result)) return result;
    // The daemon has the thread now (under its own id when it ignored ours): its transcript and list entry take over.
    void refresh();
    void loadThread(createdThreadId(result) ?? chat.threadId).catch(() => {});
    return result;
  });
}
function publish(patch: Partial<State>) {
  state = { ...state, ...patch };
  listeners.forEach((fn) => fn());
  // The machine set merges the computer's lists with the other machines' (a no-op for one machine).
  if (client && ("threads" in patch || "projects" in patch || "activity" in patch)) hub?.primaryListsChanged(client);
}
function publishThread(id: string, value: ThreadState) {
  snapshots.set(id, value);
  trimSnapshots();
  if (value.loaded) scheduleSave(id);
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
    (id) => threadListeners.has(id) || loads.has(id) || historyLoads.has(id) || linger.has(id),
    CACHED_BYTES,
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
      // A thread of another machine follows that machine's events from the moment it shows,
      // whether or not the computer the phone is at answers (#245).
      const owner = id ? remoteOwner(id) : undefined;
      if (owner) ensureRemoteEvents(owner);
      if (id) {
        linger.hold(id);
        // The disk copy shows at once, the machine online or not (#248).
        void restoreThread(id);
      }
      openHooks.forEach((open) => open(id));
      return () => {
        set.delete(fn);
        if (!set.size) {
          threadListeners.delete(id);
          if (id) linger.release(id);
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
  // The thread's own machine answering is what counts, not the computer the phone is at (#245).
  const live = useThreadLive(id);
  useEffect(() => {
    if (id && live)
      void ensureThread(id).catch((e) => publish({ error: errorText(e, "open this conversation") }));
  }, [id, live]);
  return snapshot;
}
// ---- the machine set (design §5.3): every machine the phone knows, the one it is at being the primary connection ----

const secureKv: KeyValue = {
  get: async (key) => (Platform.OS === "web" ? null : SecureStore.getItemAsync(key)),
  set: async (key, value) => {
    if (Platform.OS !== "web")
      await SecureStore.setItemAsync(key, value, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
  },
  delete: async (key) => {
    if (Platform.OS !== "web") await SecureStore.deleteItemAsync(key);
  },
};
const randomId = () => {
  const bytes = new Uint8Array(16);
  getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};
/** This phone's id for `network.client_grant`, read at boot. */
let phoneDeviceId = "kybern-mobile";
let hub: MachineHub | undefined;
let cacheFile: ReturnType<typeof machineCacheFile> | undefined;
/**
 * The phone's machine hub, made on first use. The active connection is its
 * primary machine; every other saved machine is the set's own connection.
 */
export function machineHub(): MachineHub {
  if (!hub) {
    cacheFile = machineCacheFile();
    hub = new MachineHub({
      store: machineStore(secureKv),
      credentials: machineCredentials(secureKv),
      cache: new MachineCache(cacheFile),
      itemCache: new ItemCache(itemStore("kybern-items.db")!),
      operationId: randomUUID,
      deviceId: phoneDeviceId,
      // Hermes has no Web Crypto: the identity check's nonce comes from expo-crypto (the app already ships it).
      randomFill: (bytes) => {
        getRandomValues(bytes);
      },
      socket: Platform.OS === "web" ? undefined : createNativeSocket,
      onRekey: (oldId, newId) => {
        // The daemon answered with its real id: the saved computer follows it.
        publish({
          environments: state.environments.map((e) => (e.id === oldId ? { ...e, id: newId, environmentId: newId } : e)),
          activeId: state.activeId === oldId ? newId : state.activeId,
        });
        void saveActive(secureKv, state.activeId).catch(() => {});
      },
    });
  }
  return hub;
}
/** Tests: forget the hub so the next use builds a fresh one. */
export function resetMachineHub() {
  hub?.dispose();
  hub = undefined;
}
/** The merged projects and threads of every machine. */
export function useMachineView() {
  const h = machineHub();
  return useSyncExternalStore(h.subscribe.bind(h), () => h.view());
}
/** Lists across machines as the screens read them; one machine gives the computer's own lists untouched. */
export function listsOf(view: ReturnType<MachineHub["view"]>, machine: MachineId | null): ListsView {
  const local = { projects: state.projects, threads: state.threads, activity: state.activity };
  if (view.machines.length > 1) return buildLists(view, local, machine, (id) => hub?.set.activityOf(id));
  // One machine that has not answered yet in this connection: its lists from the offline cache (#248).
  if (hub && !hub.primaryListed && !state.threads.length && !state.projects.length) {
    const cached = cachedSingleLists(view);
    if (cached) {
      markListShown(cached.threads.length, "cache");
      return cached;
    }
  }
  return singleMachineLists(local);
}

// ---- the machine a thread lives on (#245): every thread uses its own machine ----

const LIVE_MACHINE = new Set(["online", "relaying", "needs-update"]);

/** The machine a thread lives on, or undefined for the computer the phone is at (and with one machine). */
export function threadMachine(threadId: string | null | undefined): MachineId | undefined {
  return threadId ? remoteOwner(threadId) : undefined;
}

/** How a machine's connection reads on a thread screen. */
export interface MachineConnectionState {
  /** The machine; undefined before anything is known about the computer the phone is at. */
  machineId?: MachineId;
  name: string;
  status: ConnectionStatus;
  /** Requests reach it now. */
  open: boolean;
  /** It is not the computer the phone is at. */
  remote: boolean;
}

/** A machine's connection: the phone's own socket for the computer it is at, the machine set's for any other. */
export function machineConnection(machineId?: MachineId): MachineConnectionState {
  const primaryId = hub?.primaryMachineId;
  if (!machineId || !hub || machineId === primaryId) {
    const name = (primaryId && hub ? hub.set.displayName(primaryId) : undefined) || activeEnvironment()?.name || "your computer";
    return { ...(primaryId ? { machineId: primaryId } : {}), name, status: state.status, open: state.status === "open", remote: false };
  }
  const connection = hub.set.connection(machineId);
  const live = !!connection && LIVE_MACHINE.has(connection.status);
  const status: ConnectionStatus = live
    ? "open"
    : connection?.status === "unpaired"
      ? "failed"
      : connection?.connecting
        ? "reconnecting"
        : "closed";
  return { machineId, name: hub.set.displayName(machineId), status, open: live, remote: true };
}

/** The connection of the machine a thread lives on. */
export function threadConnection(threadId: string | null | undefined): MachineConnectionState {
  return machineConnection(threadMachine(threadId));
}

function subscribeConnections(fn: () => void) {
  const offApp = subscribeApp(fn);
  const offHub = machineHub().set.onChange(fn);
  return () => {
    offApp();
    offHub();
  };
}
const connectionMemo = new Map<string, MachineConnectionState>();
function memoConnection(value: MachineConnectionState): MachineConnectionState {
  const key = [value.machineId ?? "", value.name, value.status].join("\u0001");
  const old = connectionMemo.get(key);
  if (old) return old;
  if (connectionMemo.size > 64) connectionMemo.clear();
  connectionMemo.set(key, value);
  return value;
}
/** The connection of the machine a thread lives on, live: its status drives the thread's banner, composer and loading. */
export function useThreadConnection(threadId: string | null | undefined): MachineConnectionState {
  const read = useCallback(() => memoConnection(threadConnection(threadId)), [threadId]);
  return useSyncExternalStore(subscribeConnections, read, read);
}
/** True while the machine a thread lives on answers. */
export function useThreadLive(threadId: string | null | undefined): boolean {
  const read = useCallback(() => threadConnection(threadId).open, [threadId]);
  return useSyncExternalStore(subscribeConnections, read, read);
}
/** The thread's machine can serve requests about it now (its events are followed and it answers). */
function threadReady(threadId: string): boolean {
  const owner = remoteOwner(threadId);
  return owner ? machineConnection(owner).open : subscriptionReady;
}

/**
 * Answer an approval on the machine whose thread raised it: an approval of another machine's thread
 * never goes through the computer the phone is at (#245).
 */
export async function respondApproval(
  approval: Pick<ApprovalRequest, "id" | "thread_id">,
  decision: ApprovalDecision,
) {
  const owner = threadMachine(approval.thread_id);
  await rpc("approvals.respond", { approval_id: approval.id, ...decision }, owner);
  await Promise.all([refresh(owner), loadThread(approval.thread_id)]);
}

// ---- data every machine shares (spaces) ----

/**
 * The client for data the network shares: the computer the phone is at while it answers, else the
 * nearest live member (`MachineHub.memberClient`). Null while nothing answers.
 */
export function networkClient(): KybernClient | null {
  if (client?.status === "open") return hub?.primaryMachineId ? hub.set.handleFor(hub.primaryMachineId) : client;
  return hub?.memberClient(hub.primaryMachineId) ?? null;
}
const networkHooks = new Set<(client: KybernClient) => void>();
/** The computer the phone is at is away and another member answers: read shared data through it here. */
export const onNetworkClient = hook(networkHooks);
let lastNetworkClient: KybernClient | null = null;
/** True while something answers for the network (the computer the phone is at, or a member). */
export function useNetworkLive(): boolean {
  const read = useCallback(() => networkClient() !== null, []);
  return useSyncExternalStore(subscribeConnections, read, read);
}
// Notes and tasks read and write through the network (`federated.ts`): the computer the phone is at
// while it answers, else the nearest member; an item goes to the machine that holds it.
setNetworkRouting({
  network: () => {
    if (client?.status === "open") return { client: hub?.primaryMachineId ? hub.set.handleFor(hub.primaryMachineId) : client, ...(hub?.primaryMachineId ? { machineId: hub.primaryMachineId } : {}) };
    const member = hub?.memberConnection(hub.primaryMachineId);
    return member && hub ? { client: hub.set.clientFor(member.record.machineId), machineId: member.record.machineId } : hub?.primaryMachineId ? { client: hub.set.handleFor(hub.primaryMachineId), machineId: hub.primaryMachineId } : null;
  },
  machine: (machineId) =>
    hub?.set.connection(machineId) ? hub.set.handleFor(machineId) : null,
  name: (machineId) => hub?.set.displayName(machineId) ?? machineId,
  multiple: () => (hub?.machineCount ?? 0) > 1,
});
onNetworkClient(() => {
  void loadNotes();
  void loadTasks();
});
function watchNetworkClient() {
  if (client?.status === "open") {
    lastNetworkClient = null;
    return;
  }
  const next = hub?.memberClient(hub.primaryMachineId) ?? null;
  if (!next || next === lastNetworkClient) return;
  lastNetworkClient = next;
  networkHooks.forEach((fn) => fn(next));
}

/**
 * Call the daemon of the computer the user is at, or, with `machineId`, the
 * machine that owns the thread or project. Without an id the thread or project
 * in `params` picks the machine, so callers need not pass it.
 */
export function rpc<M extends MethodName>(
  method: M,
  params: ParamsOf<M>,
  machineId?: MachineId,
): Promise<ResultOf<M>> {
  const target = machineId ?? hub?.routeFor(params);
  if (hub && ['notes.list', 'notes.get', 'notes.update', 'tasks.items.list', 'tasks.items.get', 'tasks.items.update'].includes(method)) {
    const owner = target ?? hub.primaryMachineId;
    if (owner) return hub.set.handleFor(owner).call(method, params);
  }
  if (target && hub && target !== hub.primaryMachineId) {
    try {
      return hub.clientFor(target).call(method, params);
    } catch (e) {
      return Promise.reject(e);
    }
  }
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
/** A copy of the thread's transcript is on the phone (in memory or on disk): opening it shows content at once. */
export function isThreadCached(threadId: string): boolean {
  if (snapshots.get(threadId)?.loaded) return true;
  const machineId = cacheMachine(threadId);
  return !!machineId && diskSeqs.has(cacheKey(machineId, threadId));
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
/**
 * An error as one or two plain sentences, for text that cannot hold buttons. Never the raw message: the shared
 * `describeProblem` words it (`state/problems.ts`). `context` is what the person was doing ("send your message");
 * screens that can show a fix and Show details use `problemFor` instead.
 */
export function errorText(e: unknown, context?: string | PhoneContext) {
  const base = contextOf(context);
  const machine = base.machine ?? machineNameFor();
  return sentenceOf(e, machine ? { ...base, machine } : base);
}
/** The words, fix and details for `e`, for `ErrorBanner`, `ProblemState` and `showProblemToast`. */
export function problemFor(e: unknown, context: string | PhoneContext, on?: { params?: unknown; machineId?: MachineId; pr?: boolean }): ProblemModel {
  const base = contextOf(context);
  const machine = base.machine ?? machineNameFor(on?.params, on?.machineId);
  return (on?.pr ? prProblemModel : problemModel)(e, machine ? { ...base, machine } : base);
}
/** The error's own message, for code that decides what to do (never for showing). */
export function rawErrorMessage(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}
/**
 * The name of the computer a call with `params` (or `machineId`) runs on, for error copy. With neither, the paired computer, and
 * only while it is the only one: with several machines an unrouted call could be any of them, so no name is better than a wrong one.
 */
export function machineNameFor(params?: unknown, machineId?: MachineId) {
  if (!params && !machineId && hub && hub.view().machines.length > 1) return undefined;
  const id = machineId ?? (params && hub ? hub.routeFor(params) : undefined) ?? hub?.primaryMachineId;
  return (id && hub ? hub.view().machines.find((m) => m.machineId === id)?.name : undefined) ?? activeEnvironment()?.name;
}
export function clearError() {
  publish({ error: null });
}
let booted = false;
export async function boot() {
  if (booted) return;
  booted = true;
  setListCacheStorage(fileStorage());
  try {
    phoneDeviceId = await loadDeviceId(secureKv, randomId);
    const saved = await loadMachines(secureKv);
    const credentials = machineCredentials(secureKv);
    const environments: Environment[] = [];
    for (const record of saved.records) {
      const computer = computerOfRecord(record, await credentials.get(record.machineId));
      if (computer) environments.push(computer);
    }
    publish({ environments, activeId: environments.some((e) => e.id === saved.activeId) ? saved.activeId : null });
    publish({ ready: true });
    if (state.activeId) connect(state.activeId);
  } catch {
    publish({
      ready: true,
      error: "Unable to read saved connections. Add your computer again.",
    });
  }
  AppState.addEventListener("change", (next) => {
    if (next === "active") {
      void client?.checkConnection();
      void hub?.foreground().catch(() => {});
    } else {
      cacheFile?.flush();
      listCache().flush();
      void disk?.flush();
    }
  });
}
async function openCandidate(endpoint: Endpoint) {
  // Verify identity and credential before saving or replacing the active connection.
  const candidate = new KybernClient(
    { ...endpoint, url: normalizeDaemonUrl(endpoint.url) },
    {
      createSocket: Platform.OS === "web" ? undefined : createNativeSocket,
    },
  );
  return new Promise<NonNullable<KybernClient["info"]>>(
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
}
/**
 * Add a computer from its address and an access token. The first computer (or
 * the one the phone is at) becomes the connection the phone works through; any
 * other joins the set as one more machine and is connected by it.
 */
export async function addEnvironment(endpoint: Endpoint, name: string) {
  const info = await openCandidate(endpoint);
  const environment: Environment = {
    ...endpoint,
    url: normalizeDaemonUrl(endpoint.url),
    environmentId: info.environment_id,
    id: info.environment_id,
    name: name.trim() || info.hostname,
  };
  const primary = !state.activeId || state.activeId === environment.id;
  await saveEnvironment(environment, primary);
  if (primary) connect(environment.id);
}
async function saveEnvironment(environment: Environment, primary: boolean) {
  const environments = [
    ...state.environments.filter((e) => e.id !== environment.id),
    environment,
  ];
  const record = {
    machineId: environment.id,
    name: environment.name,
    routes: [{ kind: "direct_advertised" as const, url: routeUrl(environment.url) }],
  };
  // Credentials are saved before anything connects.
  if (primary) {
    await machineHub().saveComputer(record, environment.token);
    await saveActive(secureKv, environment.id);
  } else await machineHub().addMachine(record, environment.token);
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
  // the following socket handshake fails, so Settings can retry it safely. One
  // pairing is enough for the whole network: the set asks this machine for a
  // token for every other member (`network.client_grant`) once it is connected.
  await saveEnvironment(
    {
      ...endpoint,
      id: result.environment_id,
      name: name.trim() || new URL(address).hostname,
    },
    !state.activeId || state.activeId === result.environment_id,
  );
  try {
    await addEnvironment(endpoint, name);
  } catch {
    throw new Error(
      "Pairing was saved, but the live connection could not open. Open Settings → Machines to reconnect without another code.",
    );
  }
}
/** Forget a machine on this phone: its token, cached lists and record. The computer itself is untouched. */
export async function removeMachine(id: string) {
  const environments = state.environments.filter((e) => e.id !== id);
  const wasActive = state.activeId === id;
  const next = wasActive ? (environments[0]?.id ?? null) : state.activeId;
  if (wasActive) connect(null);
  publish({ environments });
  await machineHub().removeMachine(id);
  // Its transcripts and lists leave the phone with it; forgetting the last machine leaves nothing behind.
  if (environments.length) {
    void transcriptDisk()?.wipeMachine(id);
    listCache().wipeMachine(id);
  } else {
    void transcriptDisk()?.clear();
    listCache().clear();
  }
  for (const key of [...diskSeqs.keys()]) if (!environments.length || key.startsWith(`${id}\u0000`)) diskSeqs.delete(key);
  if (wasActive) {
    await saveActive(secureKv, next);
    connect(next);
  }
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
  hub?.releasePrimary();
  failover = { downSince: undefined, lastTry: 0, trying: false };
  offFailoverWatch?.();
  offFailoverWatch = undefined;
  resetRemoteEvents();
  lastNetworkClient = null;
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
  restored.clear();
  closeResumes();
  listCursor = undefined;
  if (state.activeId !== id) resumable.clear();
  else if (hub?.primaryMachineId) resumable.delete(hub.primaryMachineId);
  linger.expireAll();
  prefetch.invalidate();
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
    omitted: {},
  });
  void saveActive(secureKv, id).catch((e) => publish({ error: errorText(e, "remember this computer") }));
  const env = state.environments.find((e) => e.id === id);
  if (!env) return;
  const thisGeneration = generation;
  let appliedDefaults = false;
  const next = new KybernClient(env, {
    createSocket: Platform.OS === "web" ? undefined : createNativeSocket,
  });
  client = next;
  const machines = machineHub();
  void machines.beginPrimary(next, { machineId: env.id, name: env.name, url: env.url }).catch(() => {});
  // Empty until the first refresh answers: the set keeps the machine's cached lists until then (#245).
  machines.setPrimaryLists(next, () => ({ projects: state.projects, threads: state.threads, activity: state.activity }), { ready: false });
  attachNotes(next, () => generation === thisGeneration, env.id);
  attachTasks(next, () => generation === thisGeneration, env.id);
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
    if (status === "open") failover.downSince = undefined;
    else failover.downSince ??= Date.now();
    watchNetworkClient();
    tryOtherAddresses(thisGeneration, env, next);
    // The daemon answered: the computer joins the machine set under its machine id.
    if (status === "open") void hub?.primaryOpened(next).catch(() => {});
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
          // With a list cursor only the rows that changed come back (#248); older daemons send the whole list.
          if (hasListCursor(listCursor)) {
            void refreshChanged(next, thisGeneration).catch(() => {});
            return;
          }
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
          void loadThread(event.thread_id).catch((e) => publish({ error: errorText(e, "refresh this conversation") }));
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
        if (generation === thisGeneration) publish({ error: errorText(e, "load your projects and threads") });
      });
      void loadNotes();
      void loadTasks();
      readyHooks.forEach((ready) => ready());
      for (const id of threadListeners.keys())
        if (id)
          void loadThread(id).catch((e) => {
            if (generation === thisGeneration) publish({ error: errorText(e, "load your conversations") });
          });
    },
    (_headSeq, resumed) => {
      if (generation !== thisGeneration || !resumed) return;
      snapshots.finishReplay();
      subscriptionReady = true;
      void refresh().catch((e) => {
        if (generation === thisGeneration) publish({ error: errorText(e, "load your projects and threads") });
      });
      void loadNotes();
      void loadTasks();
      readyHooks.forEach((ready) => ready());
      for (const id of threadListeners.keys())
        if (id) void ensureThread(id).catch((e) => {
          if (generation === thisGeneration) publish({ error: errorText(e, "open this conversation") });
        });
    },
  );
  // The network may learn where this computer is now while its saved address keeps failing: look again then.
  offFailoverWatch = machines.set.onChange((event) => {
    if (event.type === "routes" || event.type === "status") tryOtherAddresses(thisGeneration, env, next);
    if (event.type === "status" || event.type === "records") watchNetworkClient();
  });
  next.connect();
}

// ---- the computer's other addresses (`addressFailover.ts`) ----

let failover: { downSince: number | undefined; lastTry: number; trying: boolean } = { downSince: undefined, lastTry: 0, trying: false };
let offFailoverWatch: (() => void) | undefined;

/**
 * The saved address of the computer the phone is at keeps failing: try the addresses the network knows for it
 * (verified as that computer by the machine set first), and move the saved computer to the first that opens.
 */
function tryOtherAddresses(thisGeneration: number, env: Environment, current: KybernClient) {
  if (generation !== thisGeneration || client !== current || !hub) return;
  const now = Date.now();
  if (!shouldTryOtherAddresses({ status: current.status, failure: current.failure, downSince: failover.downSince, lastTry: failover.lastTry, trying: failover.trying, now })) return;
  const round = failover;
  round.trying = true;
  round.lastTry = now;
  const stale = () => generation !== thisGeneration || client !== current || current.status === "open";
  void (async () => {
    try {
      for (const url of await machineHub().primaryAlternates(env.url)) {
        if (stale()) return;
        const endpoint: Endpoint = { url: normalizeDaemonUrl(url), token: env.token, ...(env.environmentId ? { environmentId: env.environmentId } : {}) };
        try {
          await openCandidate(endpoint);
        } catch {
          continue;
        }
        if (stale()) return;
        await moveComputer(env, endpoint.url);
        if (generation === thisGeneration) connect(env.id);
        return;
      }
    } catch {
      // The saved address keeps retrying; the next status change or learned route tries again.
    } finally {
      round.trying = false;
    }
  })();
}

/** The computer answers at `url` now: save that address first and keep the old one after it. */
async function moveComputer(env: Environment, url: string) {
  publish({ environments: state.environments.map((e) => (e.id === env.id ? { ...e, url } : e)) });
  const routes = [url, env.url].map((address) => ({ kind: "direct_advertised" as const, url: routeUrl(address) }));
  await machineHub().saveComputer({ machineId: env.id, name: env.name, routes }, env.token);
}
/**
 * Read the computer's lists again. With a machine id (a string: callers also
 * pass promise results here) read that other machine instead.
 */
export async function refresh(machineId?: unknown) {
  if (typeof machineId === "string" && hub && machineId !== hub.primaryMachineId) return hub.refreshMachine(machineId);
  if (!subscriptionReady) return;
  if (refreshPromise) return refreshPromise;
  const epoch = generation;
  // Provider probing can start external processes; never gate the workspace on it.
  if (!providerRefreshPromise) {
    providerRefreshPromise = rpc("providers.list", {}).then((result) => {
      if (epoch === generation) publish({ providers: result.providers });
    }).catch((e) => {
      if (epoch === generation) publish({ error: errorText(e, "load your agents") });
    }).finally(() => {
      if (epoch === generation) providerRefreshPromise = null;
    });
  }
  const events: ThreadEvent[] = [];
  indexEvents = events;
  const projectsSeen = projectChanges;
  // The first read lists active and pinned threads plus the newest settled ones per project; later reads
  // ask only for rows changed since the cursor (#248). A daemon without cursors answers with the whole list.
  const listRequest = refreshParams(listCursor, { include_archived: true });
  refreshPromise = (async () => {
    const [projects, threads, approvals, queue] = await Promise.all([
      rpc("projects.list", {}),
      rpc("threads.list", listRequest),
      rpc("approvals.list", {}),
      rpc("queue.list", {}),
    ]);
    if (epoch === generation) {
      const list = foldThreadList(listRequest, threads);
      let next: State = {
        ...state,
        // A `projects.changed` received meanwhile is newer than this list.
        projects: projectChanges === projectsSeen ? projects.projects : state.projects,
        threads: withNewChats(list.threads),
        approvals: approvals.approvals,
        // Other machines' queued prompts stay (`refreshRemoteQueue`): this computer lists only its own.
        queue: [...queue.messages, ...state.queue.filter((item) => remoteOwner(item.thread_id))],
        activity: list.activity,
        omitted: list.omitted,
        error: null,
      };
      for (const event of events) next = applyIndexEvent(next, event);
      publish(next);
      markListShown(next.threads.length, "daemon");
      if (client) hub?.primaryListsReady(client);
    }
  })().finally(() => {
    if (epoch === generation) {
      refreshPromise = null;
      indexEvents = null;
    }
  });
  return refreshPromise;
}
// ---- the thread list by cursor (`threadListCursor.ts`, #248) ----

/** The computer's list cursor: `head_seq` of the last read and the settled threads not listed yet. */
let listCursor: ThreadListState | undefined;
/**
 * Fold a `threads.list` answer into the computer's list. The previous rows are the ones on screen
 * (live events included, optimistic new chats left out), so unchanged rows keep their objects.
 */
function foldThreadList(request: ParamsOf<"threads.list">, result: ResultOf<"threads.list">): ThreadListState {
  const optimistic = new Set<Thread>(newChats.unlisted());
  const previous: ThreadListState | undefined = listCursor && {
    ...listCursor,
    threads: state.threads.filter((thread) => !optimistic.has(thread)),
    activity: state.activity,
  };
  listCursor = applyThreadList(previous, request, result);
  return listCursor;
}
/** Activity changed somewhere: read the rows that changed since the cursor. */
async function refreshChanged(on: KybernClient, thisGeneration: number) {
  if (!hasListCursor(listCursor)) return;
  const request = refreshParams(listCursor, { include_archived: true });
  const result = await on.call("threads.list", request);
  if (generation !== thisGeneration || client !== on) return;
  const list = foldThreadList(request, result);
  if (list.threads !== state.threads || list.activity !== state.activity)
    publish({ threads: withNewChats(list.threads), activity: list.activity });
}
/** The settled threads of a project the computer has not listed yet. */
export function omittedThreads(projectId: string): number {
  return state.omitted[projectId] ?? 0;
}
let moreLoading: Promise<void> | null = null;
/** "Show more" past the loaded rows: the next page of a project's older settled threads. */
export function loadMoreThreads(projectId: string): Promise<void> {
  if (moreLoading || !listCursor || !omittedThreads(projectId) || !client) return moreLoading ?? Promise.resolve();
  const on = client;
  const epoch = generation;
  const request = moreParams(listCursor, projectId, { include_archived: true });
  moreLoading = on
    .call("threads.list", request)
    .then((result) => {
      if (epoch !== generation || client !== on) return;
      const list = foldThreadList(request, result);
      publish({ threads: withNewChats(list.threads), activity: list.activity, omitted: list.omitted });
    })
    .finally(() => {
      moreLoading = null;
    });
  return moreLoading;
}

function withNewChats(listed: Thread[]): Thread[] {
  listedThreadIds = new Set(listed.map((thread) => thread.id));
  const merged = mergeOptimisticThreads(listed, newChats.unlisted());
  if (merged.listed.length) queueMicrotask(() => newChats.listed(merged.listed));
  return merged.threads;
}
/** Pull to refresh: the computer's lists and every other machine's. */
export async function refreshAll() {
  await Promise.all([refresh(), hub?.refreshOthers().catch(() => {})]);
}
// ---- threads on other machines ----

/** Event subscriptions to machines other than the primary, made when one of their threads opens. */
const remoteEvents = new Map<MachineId, { unsubscribe(): void }>();
function resetRemoteEvents() {
  remoteEvents.forEach((subscription) => subscription.unsubscribe());
  remoteEvents.clear();
}
/** The machine a listed thread lives on, when it is not the one the phone is at. */
function remoteOwner(threadId: string): MachineId | undefined {
  const owner = hub?.routeFor({ thread_id: threadId });
  return owner && owner !== hub?.primaryMachineId ? owner : undefined;
}
function ensureRemoteEvents(machineId: MachineId) {
  if (!hub || remoteEvents.has(machineId)) return;
  const thisGeneration = generation;
  const reloadOpen = () => {
    for (const id of threadListeners.keys())
      if (id && remoteOwner(id) === machineId) void loadThread(id).catch(() => {});
  };
  remoteEvents.set(
    machineId,
    hub.set.handleFor(machineId).subscribeEvents(
      {},
      (event) => {
        if (generation !== thisGeneration) return;
        hydrating.get(event.thread_id)?.push(event);
        historyLoads.get(event.thread_id)?.events.push(event);
        const snapshot = snapshots.get(event.thread_id);
        // A copy that has not caught up (restored from disk) waits for its catch-up instead of skipping a gap.
        if (snapshot?.loaded && !snapshots.isStale(event.thread_id)) publishThread(event.thread_id, applyEvent(snapshot, event));
        else if (snapshot && !hydrating.has(event.thread_id)) snapshots.invalidate(event.thread_id);
        // Queued prompts of this machine's threads follow its events (the lists stay the machine set's).
        const queue = applyIndexEvent(state, event).queue;
        if (queue !== state.queue) publish({ queue });
        if (event.kind === "workspace_reverted") {
          snapshots.invalidate(event.thread_id);
          if (threadListeners.has(event.thread_id)) void loadThread(event.thread_id).catch(() => {});
        }
      },
      undefined,
      // Events between the transcript read and the subscription acknowledging are replayed by reading again.
      () => {
        if (generation === thisGeneration) reloadOpen();
      },
    ),
  );
}

export async function loadThread(id: string, options: { prefetch?: boolean } = {}) {
  const owner = id ? remoteOwner(id) : undefined;
  if (owner) ensureRemoteEvents(owner);
  if (!id || (!subscriptionReady && !owner)) return;
  if (loads.has(id)) return loads.get(id)!;
  if (options.prefetch && snapshots.get(id)?.loaded && !snapshots.isStale(id)) return;
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
  const machineId = cacheMachine(id);
  const request = rpc("threads.get", {
    thread_id: id,
    // Settled tool output streams load when a step is opened (`threads.tool_output`).
    defer_tool_stream: true,
    // The first page by budget (whole turns, bounded rows and bytes); `transcript_limit` for older daemons.
    // A reload that keeps more history than a first page asks for all of it, as before.
    ...(requested === RECENT_ENTRIES ? firstPage() : requested <= 500 ? { transcript_limit: requested } : {}),
  })
    .then((result) => {
      if (epoch !== generation) return;
      if (machineId && result.as_of_seq !== undefined && result.as_of_seq !== null) resumable.add(machineId);
      if (owner && !options.prefetch) refreshRemoteQueue(id);
      let snapshot = seedFromGet(result);
      for (const event of buffer) snapshot = applyEvent(snapshot, event);
      if (previous)
        snapshot = retainHistoryIdentities(
          snapshot,
          snapshots.get(id) ?? previous,
        );
      restored.delete(id);
      publishThread(id, snapshot);
      snapshots.setSize(id, pageBytes(result));
      superseded = !snapshots.markFresh(id, revision);
      // A fresh copy: save it now that it is complete.
      if (!superseded) scheduleSave(id);
    })
    .finally(() => {
      if (epoch === generation) {
        loads.delete(id);
        hydrating.delete(id);
        trimSnapshots();
        // A reconnect may have acknowledged a new subscription while this old
        // request was pending. Catch up once more without clearing visible rows.
        if (superseded && subscriptionReady && threadListeners.has(id))
          void ensureThread(id).catch((e) => publish({ error: errorText(e, "open this conversation") }));
      }
    });
  loads.set(id, request);
  return request;
}
export async function ensureThread(id: string) {
  // A new chat the daemon has not made yet: its seeded record stands until the create answers.
  if (newChats.uncreated(id)) return;
  snapshots.touch(id);
  if (snapshots.get(id)?.loaded && !snapshots.isStale(id)) return;
  // The disk copy first (it is on screen at once), then catch it up from its cursor.
  await restoreThread(id);
  if (restored.has(id) && canResume(id)) {
    try {
      await resumeThread(id);
      return;
    } catch {
      // The machine could not resume it: read the first page instead.
    }
  }
  if (!snapshots.get(id)?.loaded || snapshots.isStale(id)) await loadThread(id);
}

/** Another machine's thread: its queued prompts come from that machine (the computer lists only its own). */
function refreshRemoteQueue(id: string) {
  const epoch = generation;
  void rpc("queue.list", { thread_id: id })
    .then((result) => {
      if (epoch !== generation) return;
      publish({ queue: [...state.queue.filter((item) => item.thread_id !== id), ...result.messages.filter((item) => item.thread_id === id)] });
    })
    .catch(() => {});
}

/** The first page's params (`FIRST_PAGE_BUDGET`, with the old daemons' `transcript_limit`). */
function firstPage() {
  return { page_budget: { ...FIRST_PAGE_BUDGET }, transcript_limit: RECENT_ENTRIES };
}
/** The size of a page, for the memory budget: its transcript as sent. */
function pageBytes(result: ResultOf<"threads.get">): number {
  try {
    return JSON.stringify(result.transcript).length;
  } catch {
    return 0;
  }
}
/** The client a thread's machine answers on now, or null. */
function threadClientNow(id: string): KybernClient | null {
  const owner = remoteOwner(id);
  if (owner) return hub?.liveClientFor(owner) ?? null;
  return subscriptionReady && client?.status === "open" ? client : null;
}
function canResume(id: string) {
  const machineId = cacheMachine(id);
  return !!machineId && resumable.has(machineId) && !!threadClientNow(id) && !loads.has(id);
}
const RESUME_TIMEOUT_MS = 15_000;
const resumes = new Map<string, { close(): void }>();
function closeResumes() {
  resumes.forEach((resume) => resume.close());
  resumes.clear();
}
/**
 * Catch a restored copy up from its cursor: `events.subscribe` for the thread after its `lastSeq`.
 * A small gap replays as events; a large one comes back as a fresh first page (`gap_snapshot`) that
 * keeps the rows already on screen. Events of the main stream received meanwhile are replayed after.
 */
function resumeThread(id: string): Promise<void> {
  const on = threadClientNow(id);
  const base = snapshots.get(id);
  if (!on || !base?.loaded) return Promise.reject(new Error("Not connected"));
  const epoch = generation;
  const revision = snapshots.revision(id);
  const buffer: ThreadEvent[] = [];
  hydrating.set(id, buffer);
  const request = new Promise<void>((resolve, reject) => {
    let done = false;
    let subscription: { unsubscribe(): void } | undefined;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      subscription?.unsubscribe();
      resumes.delete(id);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error("The machine did not catch the thread up in time")), RESUME_TIMEOUT_MS);
    resumes.set(id, { close: () => finish(new Error("Closed")) });
    subscription = on.subscribeEvents(
      { thread_id: id, after_seq: base.lastSeq, gap_snapshot: { thread_id: id, defer_tool_stream: true, ...firstPage() } },
      (event) => {
        if (done || epoch !== generation || event.thread_id !== id) return;
        const current = snapshots.get(id);
        if (current) publishThread(id, applyEvent(current, event));
      },
      (_head, replay) => {
        // Without the ready barrier there is no telling when the replay ends: read the page instead.
        if (!replay.supported) finish(new Error("No replay barrier"));
      },
      () => {
        if (done || epoch !== generation) return finish(new Error("Superseded"));
        let current = snapshots.get(id) ?? base;
        for (const event of [...buffer].sort((a, b) => a.seq - b.seq)) current = applyEvent(current, event);
        restored.delete(id);
        publishThread(id, current);
        if (!snapshots.markFresh(id, revision)) return finish(new Error("Superseded"));
        scheduleSave(id);
        finish();
      },
      (page) => {
        if (done || epoch !== generation) return;
        const visible = snapshots.get(id) ?? base;
        publishThread(id, retainHistoryIdentities(seedFromGet(page), visible));
        snapshots.setSize(id, pageBytes(page));
      },
    );
  }).finally(() => {
    if (epoch !== generation) return;
    loads.delete(id);
    hydrating.delete(id);
    trimSnapshots();
  });
  loads.set(id, request);
  return request;
}

export async function loadEarlier(id: string) {
  const existing = historyLoads.get(id);
  if (existing) return existing.promise;
  const base = snapshots.get(id);
  if (
    !threadReady(id) ||
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
  machineId?: MachineId,
) {
  const target = machineId ?? hub?.routeFor(params);
  const result = await rpc(method, params, target);
  // The machine that was written to reads its lists again, not only the computer the phone is at.
  await refresh(target);
  return result;
}
/** An attachment's address on the computer the phone is at; other machines go through `machineRequests.assetSource`. */
export function assetUrl(id: string) {
  try {
    return client?.request(`/assets/${encodeURIComponent(id)}`).url ?? "";
  } catch {
    return "";
  }
}
export function taskActive(task: RuntimeTask) {
  return ["pending", "running", "waiting", "stopping"].includes(task.status);
}

/** Foreground completion does not mean provider-owned background work stopped. */
export function threadHasActivity(
  thread: Thread,
  activity: readonly ThreadActivitySummary[],
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
