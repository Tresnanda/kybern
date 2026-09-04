// Single app store. Views read from here; `rpc.ts` writes into it.

import { create } from "zustand"
import { reloadOnHotUpdate } from "@/lib/hot"

import type {
  DaemonInfo,
  Diff,
  GitStatus,
  Project,
  ProviderKind,
  ProviderStatus,
  RuntimeTask,
  Settings,
  Thread,
  ThreadActivitySummary,
  ThreadId,
  ProjectId,
  TurnId,
  UserMessage,
} from "@/protocol"

import { emptyThreadState, type ThreadState } from "./transcript"
import { advanceSequence } from "./bootstrap"
import {
  canSplitPane,
  closeSplitViewPane,
  collectSplitThreadIds,
  createSplitView,
  findThreadPane,
  findThreadPaneByThreadId,
  persistSplitView,
  readPersistedSplitView,
  reconcileSplitView,
  replacePaneThread,
  resolveFocusedThreadPane,
  setSplitNodeRatio,
  splitThreadPane,
  type PaneId,
  type SplitDirection,
  type SplitSide,
  type SplitView,
} from "./splitView"

export type Connection = { state: "connecting" } | { state: "open" } | { state: "reconnecting"; detail?: string } | { state: "failed"; detail: string }

export type RightTab = "activity" | "changes" | "terminal" | "explorer"

/** A thread that has not been created on the daemon yet (Codex-style draft screen). */
export interface Draft {
  projectId: ProjectId
}

export interface TerminalTab {
  /** Client-side key; the daemon terminal id is created lazily by the tab. */
  key: string
  title: string
  /** "shell" or the agent whose CLI runs in this tab. */
  kind: "shell" | ProviderKind
  /** Program to run instead of the login shell. */
  command?: string[]
}

export interface QueuedMessage {
  id: string
  message: UserMessage
}

export interface AppState {
  connection: Connection
  info: DaemonInfo | null
  providers: ProviderStatus[]
  /** Provider discovery runs behind shell hydration and may include network-backed model catalogs. */
  providersLoading: boolean
  settings: Settings | null
  projects: Record<ProjectId, Project>
  threads: Record<ThreadId, Thread>
  transcripts: Record<ThreadId, ThreadState>
  /** Provider-owned agents, processes, and monitors, including recent history. */
  runtimeTasks: Record<ThreadId, RuntimeTask[]>
  /** Compact active counts used by the sidebar before a thread is opened. */
  threadActivity: Record<ThreadId, ThreadActivitySummary>
  /** `threadId:turnId` → diff, filled lazily for "Edited N files" cards and the changes panel. */
  diffs: Record<string, Diff>
  /** Shared git status snapshots so the dock and Environment panel do not duplicate `git`/`gh` work. */
  gitStatuses: Record<ThreadId, GitStatus>
  selected: { kind: "thread"; id: ThreadId } | { kind: "draft"; draft: Draft } | { kind: "pulls" } | { kind: "none" }
  /** Persisted recursive pane tree for showing up to four chat threads together. */
  splitView: SplitView | null
  sidebarOpen: boolean
  rightOpen: boolean
  rightTab: RightTab
  /** The floating Environment card at the right edge of a thread. */
  envOpen: boolean
  /** File to show in the explorer pane, per project. */
  explorerFile: Record<ProjectId, string | null>
  /** Terminal tabs per thread; each tab owns one pty for as long as it is listed. */
  terminalTabs: Record<ThreadId, TerminalTab[]>
  activeTerminalTab: Record<ThreadId, string | null>
  /** Turn ids the user expanded in the transcript. */
  expandedWork: Record<TurnId, boolean>
  paletteOpen: boolean
  settingsOpen: boolean
  settingsTab: "general" | "agents" | "appearance" | "usage" | "about"
  collapsedProjects: Record<ProjectId, boolean>
  /** Messages waiting for the current turn to finish, per thread. */
  queued: Record<ThreadId, QueuedMessage[]>
  /** Thread being handed off to another agent, when the picker is open. */
  handoffThread: ThreadId | null
  /** Preselected agent for the hand-off picker, when opened from a provider-specific menu item. */
  handoffTarget: ProviderKind | null
}

export interface AppActions {
  set: (patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)) => void
  transcript: (id: ThreadId) => ThreadState
  updateTranscript: (id: ThreadId, f: (t: ThreadState) => ThreadState) => void
  selectThread: (id: ThreadId) => void
  selectDraft: (projectId: ProjectId) => void
  selectPulls: () => void
  splitFocusedPane: (
    direction: SplitDirection,
    threadId?: ThreadId,
    side?: SplitSide
  ) => boolean
  openThreadInSplit: (threadId: ThreadId, direction: SplitDirection) => boolean
  dropThreadOnPane: (
    paneId: PaneId,
    threadId: ThreadId,
    direction: SplitDirection,
    side: SplitSide
  ) => boolean
  focusSplitPane: (paneId: PaneId) => void
  closeSplitPane: (paneId: PaneId) => boolean
  maximizeSplitPane: (paneId: PaneId) => boolean
  setSplitRatio: (splitNodeId: PaneId, ratio: number) => void
  exitSplitView: () => void
  removeThreadFromSplit: (threadId: ThreadId) => void
  reconcileSplitThreads: (threadIds: readonly ThreadId[]) => void
  toggleWork: (turnId: TurnId) => void
  toggleProject: (id: ProjectId) => void
  enqueue: (threadId: ThreadId, message: UserMessage) => void
  dequeue: (threadId: ThreadId, id: string) => QueuedMessage | undefined
}

export type Store = AppState & AppActions

export const useStore = create<Store>()((set, get) => ({
  connection: { state: "connecting" },
  info: null,
  providers: [],
  providersLoading: true,
  settings: null,
  projects: {},
  threads: {},
  transcripts: {},
  runtimeTasks: {},
  threadActivity: {},
  diffs: {},
  gitStatuses: {},
  selected: { kind: "none" },
  splitView: readPersistedSplitView(),
  sidebarOpen: true,
  rightOpen: false,
  rightTab: "changes",
  envOpen: false,
  explorerFile: {},
  terminalTabs: {},
  activeTerminalTab: {},
  expandedWork: {},
  paletteOpen: false,
  settingsOpen: false,
  settingsTab: "general",
  collapsedProjects: {},
  queued: {},
  handoffThread: null,
  handoffTarget: null,

  set: (patch) => set(typeof patch === "function" ? patch : () => patch),
  transcript: (id) => get().transcripts[id] ?? emptyThreadState(),
  updateTranscript: (id, f) =>
    set((s) => {
      const stored = s.transcripts[id]
      const currentThread = s.threads[id]
      const prev = stored ?? {
        ...emptyThreadState(),
        thread: currentThread ?? null,
        lastSeq: currentThread?.last_seq ?? 0,
      }
      let next = f(prev)
      // Event payloads can contain the thread projection from immediately
      // before that event was assigned a sequence. Keep the client projection
      // at the fold's actual high-water mark so an in-flight snapshot cannot
      // roll it back later.
      if (next.thread && next.thread.last_seq < next.lastSeq) {
        next = { ...next, thread: advanceSequence(next.thread, next.lastSeq) }
      }
      if (next === prev) return {}
      const threads = next.thread && next.thread !== prev.thread ? { ...s.threads, [id]: next.thread } : s.threads
      return { transcripts: { ...s.transcripts, [id]: next }, threads }
    }),
  selectThread: (id) =>
    set((state) => {
      const splitView = state.splitView
      if (!splitView) return { selected: { kind: "thread", id } }

      const existing = findThreadPaneByThreadId(splitView.root, id)
      const target = existing ?? resolveFocusedThreadPane(splitView)
      if (!target) return { selected: { kind: "thread", id } }
      const root = existing
        ? splitView.root
        : replacePaneThread(splitView.root, target.id, id)
      const next = { root: root as SplitView["root"], focusedPaneId: target.id }
      persistSplitView(next)
      return { selected: { kind: "thread", id }, splitView: next }
    }),
  selectDraft: (projectId) => {
    persistSplitView(null)
    set({ selected: { kind: "draft", draft: { projectId } }, splitView: null })
  },
  selectPulls: () => {
    persistSplitView(null)
    set({ selected: { kind: "pulls" }, splitView: null })
  },
  splitFocusedPane: (direction, threadId, side = "second") => {
    const state = get()
    if (!state.splitView) {
      if (state.selected.kind !== "thread") return false
      const addedThreadId =
        threadId === state.selected.id ? null : (threadId ?? null)
      const splitView = createSplitView({
        sourceThreadId: state.selected.id,
        threadId: addedThreadId,
        direction,
        side,
      })
      persistSplitView(splitView)
      set({
        splitView,
        selected: addedThreadId
          ? { kind: "thread", id: addedThreadId }
          : { kind: "none" },
      })
      return true
    }

    const splitView = state.splitView
    if (threadId) {
      const existing = findThreadPaneByThreadId(splitView.root, threadId)
      if (existing) {
        const next = { ...splitView, focusedPaneId: existing.id }
        persistSplitView(next)
        set({ splitView: next, selected: { kind: "thread", id: threadId } })
        return true
      }
    }

    const target = resolveFocusedThreadPane(splitView)
    if (!target) return false
    if (target.threadId === null && threadId) {
      const next = {
        root: replacePaneThread(
          splitView.root,
          target.id,
          threadId
        ) as SplitView["root"],
        focusedPaneId: target.id,
      }
      persistSplitView(next)
      set({ splitView: next, selected: { kind: "thread", id: threadId } })
      return true
    }
    if (
      target.threadId === null ||
      !canSplitPane(splitView.root, target.id, direction)
    )
      return false

    const result = splitThreadPane({
      root: splitView.root,
      targetPaneId: target.id,
      direction,
      threadId: threadId ?? null,
      side,
    })
    if (!result || result.root.kind !== "split") return false
    const next = { root: result.root, focusedPaneId: result.addedPaneId }
    persistSplitView(next)
    set({
      splitView: next,
      selected: threadId ? { kind: "thread", id: threadId } : { kind: "none" },
    })
    return true
  },
  openThreadInSplit: (threadId, direction) => {
    const state = get()
    if (state.splitView || state.selected.kind === "thread") {
      return get().splitFocusedPane(direction, threadId)
    }
    const splitView = createSplitView({ sourceThreadId: threadId, direction })
    persistSplitView(splitView)
    set({ splitView, selected: { kind: "none" } })
    return true
  },
  dropThreadOnPane: (paneId, threadId, direction, side) => {
    const splitView = get().splitView
    if (!splitView) return false
    const existing = findThreadPaneByThreadId(splitView.root, threadId)
    if (existing) {
      const next = { ...splitView, focusedPaneId: existing.id }
      persistSplitView(next)
      set({ splitView: next, selected: { kind: "thread", id: threadId } })
      return true
    }
    const target = findThreadPane(splitView.root, paneId)
    if (!target) return false
    if (!target.threadId) {
      const next = {
        root: replacePaneThread(
          splitView.root,
          paneId,
          threadId
        ) as SplitView["root"],
        focusedPaneId: paneId,
      }
      persistSplitView(next)
      set({ splitView: next, selected: { kind: "thread", id: threadId } })
      return true
    }
    if (!canSplitPane(splitView.root, paneId, direction)) return false
    const result = splitThreadPane({
      root: splitView.root,
      targetPaneId: paneId,
      direction,
      threadId,
      side,
    })
    if (!result || result.root.kind !== "split") return false
    const next = { root: result.root, focusedPaneId: result.addedPaneId }
    persistSplitView(next)
    set({ splitView: next, selected: { kind: "thread", id: threadId } })
    return true
  },
  focusSplitPane: (paneId) => {
    const splitView = get().splitView
    if (!splitView || splitView.focusedPaneId === paneId) return
    const pane = findThreadPane(splitView.root, paneId)
    if (!pane) return
    const next = { ...splitView, focusedPaneId: paneId }
    persistSplitView(next)
    set({
      splitView: next,
      selected: pane.threadId
        ? { kind: "thread", id: pane.threadId }
        : { kind: "none" },
    })
  },
  closeSplitPane: (paneId) => {
    const state = get()
    const splitView = state.splitView
    if (!splitView) return false
    const closed = findThreadPane(splitView.root, paneId)
    const result = closeSplitViewPane(splitView, paneId)
    if (!result) return false

    const fallbackProjectId =
      (closed?.threadId
        ? state.threads[closed.threadId]?.project_id
        : undefined) ?? Object.keys(state.projects)[0]
    persistSplitView(result.splitView)
    set({
      splitView: result.splitView,
      selected: result.threadId
        ? { kind: "thread", id: result.threadId }
        : fallbackProjectId
          ? { kind: "draft", draft: { projectId: fallbackProjectId } }
          : { kind: "none" },
    })
    return true
  },
  maximizeSplitPane: (paneId) => {
    const splitView = get().splitView
    const pane = splitView ? findThreadPane(splitView.root, paneId) : null
    if (!pane) return false
    persistSplitView(null)
    set({
      splitView: null,
      selected: pane.threadId
        ? { kind: "thread", id: pane.threadId }
        : { kind: "none" },
    })
    return true
  },
  setSplitRatio: (splitNodeId, ratio) => {
    const splitView = get().splitView
    if (!splitView) return
    const root = setSplitNodeRatio(splitView.root, splitNodeId, ratio)
    if (root === splitView.root || root.kind !== "split") return
    const next = { ...splitView, root }
    persistSplitView(next)
    set({ splitView: next })
  },
  exitSplitView: () => {
    const splitView = get().splitView
    if (!splitView) return
    const focused = resolveFocusedThreadPane(splitView)
    const fallbackId = collectSplitThreadIds(splitView)[0] ?? null
    const threadId = focused?.threadId ?? fallbackId
    persistSplitView(null)
    set({
      splitView: null,
      selected: threadId ? { kind: "thread", id: threadId } : { kind: "none" },
    })
  },
  removeThreadFromSplit: (threadId) => {
    const state = get()
    const pane = state.splitView
      ? findThreadPaneByThreadId(state.splitView.root, threadId)
      : null
    if (pane) {
      get().closeSplitPane(pane.id)
    } else if (
      state.selected.kind === "thread" &&
      state.selected.id === threadId
    ) {
      const projectId =
        state.threads[threadId]?.project_id ?? Object.keys(state.projects)[0]
      set({
        selected: projectId
          ? { kind: "draft", draft: { projectId } }
          : { kind: "none" },
      })
    }
  },
  reconcileSplitThreads: (threadIds) => {
    const current = get().splitView
    if (!current) return
    const next = reconcileSplitView(current, new Set(threadIds))
    persistSplitView(next)
    if (!next) {
      set({ splitView: null, selected: { kind: "none" } })
      return
    }
    const focused = resolveFocusedThreadPane(next)
    set({
      splitView: next,
      selected: focused?.threadId
        ? { kind: "thread", id: focused.threadId }
        : { kind: "none" },
    })
  },
  toggleWork: (turnId) => set((s) => ({ expandedWork: { ...s.expandedWork, [turnId]: !s.expandedWork[turnId] } })),
  toggleProject: (id) => set((s) => ({ collapsedProjects: { ...s.collapsedProjects, [id]: !s.collapsedProjects[id] } })),
  enqueue: (threadId, message) =>
    set((s) => ({
      queued: { ...s.queued, [threadId]: [...(s.queued[threadId] ?? []), { id: crypto.randomUUID(), message }] },
    })),
  dequeue: (threadId, id) => {
    const list = get().queued[threadId] ?? []
    const item = list.find((q) => q.id === id)
    if (item) set((s) => ({ queued: { ...s.queued, [threadId]: (s.queued[threadId] ?? []).filter((q) => q.id !== id) } }))
    return item
  },
}))

// ---- selectors ----

export const selectThreadsForProject = (s: AppState, projectId: ProjectId): Thread[] =>
  Object.values(s.threads)
    .filter((t) => t.project_id === projectId && t.status !== "archived")
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated_at.localeCompare(a.updated_at))

export const selectRecentThreads = (s: AppState): Thread[] =>
  Object.values(s.threads)
    .filter((t) => t.status !== "archived")
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))

export const selectSelectedThread = (s: AppState): Thread | null =>
  s.selected.kind === "thread" ? (s.threads[s.selected.id] ?? null) : null

export const isThreadVisible = (s: AppState, threadId: ThreadId): boolean =>
  (s.selected.kind === "thread" && s.selected.id === threadId) ||
  collectSplitThreadIds(s.splitView).includes(threadId)

export const selectAvailableProviders = (s: AppState): ProviderStatus[] => s.providers.filter((p) => p.available)

export const isRuntimeTaskActive = (task: RuntimeTask): boolean =>
  task.status === "pending" || task.status === "running" || task.status === "waiting" || task.status === "stopping"

export const selectRuntimeTasks = (s: AppState, threadId: ThreadId): RuntimeTask[] => s.runtimeTasks[threadId] ?? []

/** Stable launch order for live work, newest-first for history, with children
 * kept immediately beneath their parent. Metric ticks must not reorder rows. */
export function sortRuntimeTasks(input: RuntimeTask[]): RuntimeTask[] {
  const orderGroup = (tasks: RuntimeTask[], newestFirst: boolean) => {
    const ids = new Set(tasks.map((task) => task.id))
    const children = new Map<string | null, RuntimeTask[]>()
    for (const task of tasks) {
      const parent = task.parent_id && ids.has(task.parent_id) ? task.parent_id : null
      children.set(parent, [...(children.get(parent) ?? []), task])
    }
    const compare = (left: RuntimeTask, right: RuntimeTask) => {
      const leftSeq = newestFirst ? left.updated_seq : left.started_seq
      const rightSeq = newestFirst ? right.updated_seq : right.started_seq
      const sequence = leftSeq > 0 && rightSeq > 0
        ? newestFirst ? rightSeq - leftSeq : leftSeq - rightSeq
        : 0
      if (sequence) return sequence
      const time = newestFirst ? right.updated_at.localeCompare(left.updated_at) : left.started_at.localeCompare(right.started_at)
      return time || left.id.localeCompare(right.id)
    }
    for (const siblings of children.values()) siblings.sort(compare)

    const ordered: RuntimeTask[] = []
    const seen = new Set<string>()
    const append = (parent: string | null) => {
      for (const task of children.get(parent) ?? []) {
        if (seen.has(task.id)) continue
        seen.add(task.id)
        ordered.push(task)
        append(task.id)
      }
    }
    append(null)
    ordered.push(...tasks.filter((task) => !seen.has(task.id)).sort(compare))
    return ordered
  }

  return [
    ...orderGroup(input.filter(isRuntimeTaskActive), false),
    ...orderGroup(input.filter((task) => !isRuntimeTaskActive(task)), true),
  ]
}

/** Merge an RPC snapshot with live events without letting an older response
 * roll back task progress. Terminal evidence wins timestamp ties. */
export function mergeRuntimeTasks(current: RuntimeTask[], incoming: RuntimeTask[]): RuntimeTask[] {
  const merged = new Map(current.map((task) => [task.id, task]))
  for (const incomingTask of incoming) {
    const previous = merged.get(incomingTask.id)
    const task = previous
      ? { ...incomingTask, started_seq: previous.started_seq || incomingTask.started_seq }
      : incomingTask
    const newerBySequence = !!previous && task.updated_seq > previous.updated_seq
    const olderBySequence = !!previous && task.updated_seq < previous.updated_seq && (task.updated_seq > 0 || previous.updated_seq > 0)
    const newer = !previous || newerBySequence || (!olderBySequence && task.updated_seq === previous.updated_seq && task.updated_at > previous.updated_at)
    const tiedAndNotRegressing =
      !!previous && task.updated_seq === previous.updated_seq && task.updated_at === previous.updated_at && (isRuntimeTaskActive(previous) || !isRuntimeTaskActive(task))
    const terminalRegression = !!previous && !isRuntimeTaskActive(previous) && isRuntimeTaskActive(task)
    if (!terminalRegression && (newer || tiedAndNotRegressing)) merged.set(task.id, task)
  }
  return sortRuntimeTasks([...merged.values()])
}

export function summarizeRuntimeTasks(threadId: ThreadId, tasks: RuntimeTask[]): ThreadActivitySummary {
  const active = tasks.filter(isRuntimeTaskActive)
  const active_agents = active.filter((task) => task.kind === "agent").length
  const active_processes = active.filter((task) => task.kind === "process").length
  const active_monitors = active.filter((task) => task.kind === "monitor").length
  return {
    thread_id: threadId,
    state: active_agents > 0 ? "working" : active_processes > 0 || active_monitors > 0 ? "monitoring" : undefined,
    active_agents,
    active_processes,
    active_monitors,
  }
}

export const diffKey = (threadId: ThreadId, turnId?: TurnId | null) => `${threadId}:${turnId ?? "all"}`

// Stateful module: a hot update would drop the live connection, so reload instead.
reloadOnHotUpdate(import.meta.hot)
