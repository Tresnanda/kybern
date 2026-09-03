// Single app store. Views read from here; `rpc.ts` writes into it.

import { create } from "zustand"
import { reloadOnHotUpdate } from "@/lib/hot"

import type { DaemonInfo, Diff, Project, ProviderKind, ProviderStatus, Settings, Thread, ThreadId, ProjectId, TurnId, UserMessage } from "@/protocol"

import { emptyThreadState, type ThreadState } from "./transcript"

export type Connection = { state: "connecting" } | { state: "open" } | { state: "reconnecting"; detail?: string } | { state: "failed"; detail: string }

export type RightTab = "changes" | "terminal" | "explorer"

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
  settings: Settings | null
  projects: Record<ProjectId, Project>
  threads: Record<ThreadId, Thread>
  transcripts: Record<ThreadId, ThreadState>
  /** `threadId:turnId` → diff, filled lazily for "Edited N files" cards and the changes panel. */
  diffs: Record<string, Diff>
  selected: { kind: "thread"; id: ThreadId } | { kind: "draft"; draft: Draft } | { kind: "pulls" } | { kind: "none" }
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
  settings: null,
  projects: {},
  threads: {},
  transcripts: {},
  diffs: {},
  selected: { kind: "none" },
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
      const prev = s.transcripts[id] ?? emptyThreadState()
      const next = f(prev)
      if (next === prev) return {}
      const threads = next.thread && next.thread !== prev.thread ? { ...s.threads, [id]: next.thread } : s.threads
      return { transcripts: { ...s.transcripts, [id]: next }, threads }
    }),
  selectThread: (id) => set({ selected: { kind: "thread", id } }),
  selectDraft: (projectId) => set({ selected: { kind: "draft", draft: { projectId } } }),
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

export const selectAvailableProviders = (s: AppState): ProviderStatus[] => s.providers.filter((p) => p.available)

export const diffKey = (threadId: ThreadId, turnId?: TurnId | null) => `${threadId}:${turnId ?? "all"}`

// Stateful module: a hot update would drop the live connection, so reload instead.
reloadOnHotUpdate(import.meta.hot)
