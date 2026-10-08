import { readProviderCache } from "./providerCache"
// Single app store. Views read from here; `rpc.ts` writes into it.

import { create, type UseBoundStore, type StoreApi } from "zustand"
import { reloadOnHotUpdate } from "@/lib/hot"
import { DEFAULT_SIDEBAR_FILTER, type SidebarFilter } from "./sidebarOrganize"
import type { ThreadMessageIndex } from "../../../../packages/kybern-client/src/messageStates.ts"
import { isChildThread } from "../../../../packages/kybern-client/src/subagents.ts"

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
  HtmlVisual,
  ThreadEvent,
  ThreadMessageRecord,
  ProjectId,
  TurnId,
  UserMessage,
} from "@/protocol"

import { applyEvent, applyBackgroundEvent, compactThreadState, emptyThreadState, type ThreadState } from "./transcript"
import { createRetentionPolicy } from "./retention"
import { windowHoldsTranscript } from "./windowSurfaceState"
import { advanceSequence } from "./bootstrap"
import {
  EMPTY_NAV_HISTORY,
  moveNavHistory,
  navEntryFromSelected,
  recordNavEntry,
  type NavEntry,
  type NavHistory,
  type NavMode,
} from "./navHistory"
import {
  persistWorkspace,
  readWorkspace,
  workspaceKey,
} from "./environmentWorkspace"
import {
  canSplitPane,
  closeSplitViewPane,
  collectOpenThreadIds as collectOpenThreadIdsFromSplit,
  collectSplitThreadIds,
  createSplitView,
  findThreadPane,
  findThreadPaneByThreadId,
  persistSplitView as saveSplitView,
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
import {
  persistThreadNotificationState,
  readThreadNotificationState,
  selectAttentionItems,
  threadAttentionSequence,
  threadStatusAttentionKind,
  type NotificationKind,
  type ThreadNotificationDismissal,
  type ThreadNotification,
} from "./notifications"

export type Connection =
  | { state: "connecting" }
  | { state: "open" }
  | { state: "reconnecting"; detail?: string }
  | { state: "failed"; detail: string }

export type RightTab = "collaboration" | "activity" | "changes" | "terminal" | "explorer" | "artifacts" | "notes" | "tasks" | "review" | "preview"

/** A resolved web preview address. File targets carry the daemon's canonical path and serving root. */
export type PreviewTarget =
  | { kind: "file"; path: string; root: string; display: string; inProject?: boolean }
  | { kind: "server"; url: string; relay?: boolean }
  | { kind: "external"; url: string; query?: string }
export type WebPreviewEntry = { target: PreviewTarget; title?: string }
export type PreviewViewport =
  | { mode: "fill" }
  | { mode: "device"; presetId: string | null; width: number; height: number }
/** A file outside the project waits for the user's one-time folder grant. */
export type PendingPermission = {
  /** The address as typed or requested; sent again with `allow_folder`. */
  input: string
  folder: string
  grantable: boolean
  title?: string
  /** Set when an agent asked; the card names it and the tab shows an unseen dot. */
  agent?: boolean
}
/** A page an agent opened while the user was navigating; offered, never forced. */
export type QueuedPreview = { input: string; title?: string }
export type WebPreview = {
  kind: "web"
  entries: WebPreviewEntry[]
  index: number
  viewport: PreviewViewport
  floating: boolean
  /** Bumps on every navigation request, so reopening the same address reloads it. */
  revision: number
  pending?: PendingPermission
  queued?: QueuedPreview
  /** Epoch ms of the user's last navigation, for the 10 second agent grace. */
  navigatedAt?: number
  /** True until the Preview tab is next shown (the accent dot on the tab). */
  unseen?: boolean
}
/** What a thread's dock Preview tab shows. Kinds share the Preview shell. */
export type DockPreview = { kind: "visual"; visual: HtmlVisual; mode: "rendered" | "source" } | WebPreview
const MAX_DOCK_PREVIEWS = 32
const MAX_PREVIEW_HISTORY = 50
export const AGENT_PREVIEW_GRACE_MS = 10_000

function emptyWebPreview(): WebPreview {
  return { kind: "web", entries: [], index: -1, viewport: { mode: "fill" }, floating: false, revision: 0 }
}
function sameTarget(a: PreviewTarget, b: PreviewTarget): boolean {
  if (a.kind !== b.kind) return false
  return a.kind === "file" ? a.path === (b as typeof a).path : a.url === (b as typeof a).url
}

/** A thread that has not been created on the daemon yet (Codex-style draft screen). */
export interface Draft {
  /** Missing for a free chat that is not attached to a user project. */
  projectId?: ProjectId
  purpose?: "thread" | "coordinator"
}

export interface TerminalTab {
  /** Client-side key; the daemon terminal id is created lazily by the tab. */
  key: string
  title: string
  /** "shell" or the agent whose CLI runs in this tab. */
  kind: "shell" | ProviderKind
  /** Program to run instead of the login shell. */
  command?: string[]
  /** Stable daemon PTY; detaching a view leaves the process running. */
  terminalId?: string
  daemonStartedAt?: string
  /** A provider sign-in process created before this tab was opened. */
  connectorLogin?: boolean
}

export interface QueuedMessage {
  id: string
  message: UserMessage
}

export interface AppState {
  environmentId: string
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
  /** Threads that need attention (finished, failed, or waiting on you) and have
   *  not been opened since. Backs the sidebar notification bell. */
  notifications: Record<ThreadId, ThreadNotification>
  /** Current attention cursors dismissed from the bell, persisted per environment. */
  notificationDismissals: Record<ThreadId, ThreadNotificationDismissal>
  /** `threadId:turnId` → diff, filled lazily for "Edited N files" cards and the changes panel. */
  diffs: Record<string, Diff>
  /** Shared git status snapshots so the dock and Environment panel do not duplicate `git`/`gh` work. */
  prSelection: { projectId: ProjectId; number: number } | null
  worktreeCleanupThread: ThreadId | null
  gitStatuses: Record<ThreadId, GitStatus>
  selected:
    | { kind: "thread"; id: ThreadId }
    | { kind: "draft"; draft: Draft }
    | { kind: "pulls" }
    | { kind: "usage" }
    /** Notes page; `noteId` is the open note, if any. */
    | { kind: "notes"; noteId?: string }
    /** Tasks page; `taskId` is the open task, if any. */
    | { kind: "tasks"; taskId?: string }
    | { kind: "none" }
  /** Back and forward steps through the main views. Not persisted. */
  navHistory: NavHistory
  /** The chat (thread or draft) to return to when Home is chosen from another page. */
  homeSelection: { kind: "thread"; id: ThreadId } | { kind: "draft"; draft: Draft } | null
  /** Persisted recursive pane tree for showing up to four chat threads together. */
  splitView: SplitView | null
  sidebarOpen: boolean
  /** Pull requests hide the thread panel; ⌘B peeks it here without changing `sidebarOpen`. Not persisted. */
  pullsPanelPeek: boolean
  /** When on, the sidebar shows only threads that need attention (bell filter). */
  notificationFilter: boolean
  rightOpen: boolean
  rightTabs: RightTab[]
  rightTab: RightTab | null
  /** In-memory dock previews, one per thread (never persisted). */
  previews: Record<ThreadId, DockPreview>
  /** Show a visual reply in the dock Preview tab, replacing the thread's previous preview. */
  openVisualPreview: (threadId: ThreadId, visual: HtmlVisual) => void
  setPreviewMode: (threadId: ThreadId, mode: "rendered" | "source") => void
  /**
   * Show a web page in the dock Preview tab (a visual is replaced). `focus: false` keeps keyboard
   * focus where it is; an agent request within 10 seconds of the user's own navigation is queued.
   */
  openWebPreview: (threadId: ThreadId, target: PreviewTarget, options?: { title?: string; requestedByAgent?: boolean; focus?: boolean; input?: string }) => void
  /** Show the grant card for a file outside the project, without leaving the previous page. */
  requestPreviewPermission: (threadId: ThreadId, pending: PendingPermission, options?: { focus?: boolean }) => void
  /** Cancel or finish the grant card. */
  clearPreviewPermission: (threadId: ThreadId) => void
  /** Accept (`true`) or drop the queued agent page; the caller opens it. */
  clearQueuedPreview: (threadId: ThreadId) => void
  /** Walk Kybern's history for the page; no-op at either end. */
  navigatePreview: (threadId: ThreadId, delta: -1 | 1) => void
  setPreviewViewport: (threadId: ThreadId, viewport: PreviewViewport) => void
  /** Float the page over the chat (one floating page at a time) or return it to the dock. */
  setPreviewFloating: (threadId: ThreadId, floating: boolean, options?: { reveal?: boolean }) => void
  /** Record the title a page reported on its current entry. */
  setPreviewTitle: (threadId: ThreadId, title: string) => void
  /** Switch the current entry to the relayed load ("Preview through Kybern"). */
  setPreviewRelay: (threadId: ThreadId, relay: boolean) => void
  /** Back to the empty state for this thread; the tab stays. */
  closePreviewPage: (threadId: ThreadId) => void
  markPreviewSeen: (threadId: ThreadId) => void
  /** Remove a thread's preview and close the Preview tab. */
  closePreview: (threadId: ThreadId) => void
  /** The floating Environment card at the right edge of a thread. */
  envOpen: boolean
  /** File to show in the explorer pane, per project. */
  explorerFile: Record<ProjectId, string | null>
  /** Terminal tabs per thread; each tab owns one pty for as long as it is listed. */
  terminalTabs: Record<ThreadId, TerminalTab[]>
  activeTerminalTab: Record<ThreadId, string | null>
  /** Turn ids the user expanded in the transcript. */
  expandedWork: Record<TurnId, boolean>
  sessionsOpen: boolean
  sessionsProjectId: ProjectId | null
  paletteOpen: boolean
  settingsOpen: boolean
  settingsTab: "general" | "agents" | "accounts" | "integrations" | "computer" | "appearance" | "notifications" | "background" | "about"
  /** A settings row to bring into view when Settings opens, e.g. `provider:cursor`. */
  settingsFocus: string | null
  collapsedProjects: Record<ProjectId, boolean>
  /** Project order the user dragged into place. Empty means alphabetical. */
  projectOrder: ProjectId[]
  /** Which threads the sidebar lists. */
  sidebarFilter: SidebarFilter
  /** Messages waiting for the current turn to finish, per thread. */
  queued: Record<ThreadId, QueuedMessage[]>
  /** Messages another thread sent here that need the reader's approval, per recipient. */
  heldMessages: Record<ThreadId, ThreadMessageRecord[]>
  /** Bounded records of the messages a thread sent or received, for the live state of "Sent to" rows. See `threadMessages.ts`. */
  messageRecords: Record<ThreadId, ThreadMessageIndex>
  composerDrafts: Record<
    string,
    {
      text: string
      attachments: {
        id: string
        name: string
        media_type: string
        size: number
      }[]
      mentions: string[]
      skills: import("@/protocol").SkillInfo[]
      threadReferences: import("../../../../packages/kybern-client/src/threadReferences").ComposerThreadReference[]
    }
  >
  /** Thread being handed off to another agent, when the picker is open. */
  handoffThread: ThreadId | null
  /** Preselected agent for the hand-off picker, when opened from a provider-specific menu item. */
  handoffTarget: ProviderKind | null
}

export interface AppActions {
  set: (patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)) => void
  receiveEvent: (event: ThreadEvent) => void
  releaseCachedData: () => void
  transcript: (id: ThreadId) => ThreadState
  updateTranscript: (id: ThreadId, f: (t: ThreadState) => ThreadState) => void
  selectThread: (id: ThreadId) => void
  /** Show a thread just created from the draft on screen: the draft's history step becomes the thread's. */
  selectCreatedThread: (id: ThreadId) => void
  selectDraft: (projectId: ProjectId, purpose?: "thread" | "coordinator") => void
  selectFreeDraft: () => void
  selectPulls: () => void
  selectUsage: () => void
  /** Open the Notes page, optionally on one note. */
  selectNotes: (noteId?: string) => void
  /** Open the Tasks page, optionally on one task. */
  selectTasks: (taskId?: string) => void
  /** Return to the last chat, or the home screen when none is left. */
  selectHome: () => void
  /** Run a selection that is not the user's move (boot, a removed project) so it replaces the current history step. */
  replaceNavigation: (select: () => void) => void
  /**
   * Show the nearest valid history entry in `delta`'s direction, alone (split view is not
   * history), without recording a new step. Returns the entry shown, or null at the end.
   */
  moveNavigation: (delta: -1 | 1, isValid: (entry: NavEntry) => boolean) => NavEntry | null
  /** Record that a thread needs attention (bell + sidebar unread marker). */
  pushNotification: (threadId: ThreadId, kind: NotificationKind, seq: number, at: string) => void
  /** Clear a thread's notification (it has been opened / acknowledged). */
  clearNotification: (threadId: ThreadId) => void
  /** Hide every current attention item without changing thread/approval state. */
  dismissAllNotifications: () => void
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
  setProjectOrder: (order: ProjectId[]) => void
  setSidebarFilter: (filter: Partial<SidebarFilter>) => void
}

export type Store = AppState & AppActions

export type EnvironmentStore = UseBoundStore<StoreApi<Store>>

/** Remove a thread's notification, persisting the change. `{}` when there was none. */
function clearNotificationPatch(state: AppState, threadId: ThreadId): { notifications?: Record<ThreadId, ThreadNotification> } {
  if (!(threadId in state.notifications)) return {}
  const notifications = { ...state.notifications }
  delete notifications[threadId]
  persistThreadNotificationState(notifications, state.notificationDismissals, state.environmentId)
  return { notifications }
}

/**
 * Keep a dismissed live status attached to the status transition that made it
 * visible. Metadata-only thread updates advance the cursor so a rename or pin
 * change does not resurrect the same stale failure. Explicit failure/request
 * events clear it first, so a genuinely new attention event still surfaces.
 */
function reconcileNotificationDismissalForEvent(
  state: AppState,
  event: ThreadEvent,
): Record<ThreadId, ThreadNotificationDismissal> | undefined {
  const current = state.notificationDismissals[event.thread_id]
  if (!current || event.seq <= current.seq) return undefined

  const explicitKind = event.kind === "turn_failed" ? "failed"
    : event.kind === "approval_requested" || event.kind === "user_input_requested" ? "blocked"
    : null
  if (explicitKind === current.kind) {
    const next = { ...state.notificationDismissals }
    delete next[event.thread_id]
    return next
  }
  if (event.kind !== "thread_updated") return undefined

  const incomingKind = threadStatusAttentionKind(event.thread.status)
  if (incomingKind !== current.kind || typeof event.thread.last_seq !== "number") return undefined
  const previous = state.threads[event.thread_id]
  const previousKind = previous ? threadStatusAttentionKind(previous.status) : null
  if (!previous || previousKind !== incomingKind) {
    const next = { ...state.notificationDismissals }
    delete next[event.thread_id]
    return next
  }
  // Carry the dismissal only while it covers everything already received.
  // An unseen newer snapshot must remain eligible to notify.
  const knownSeq = Math.max(previous.last_seq, state.transcripts[event.thread_id]?.lastSeq ?? 0)
  if (current.seq < knownSeq) return undefined
  return {
    ...state.notificationDismissals,
    [event.thread_id]: { ...current, seq: Math.max(event.seq, event.thread.last_seq) },
  }
}

/** Keep the chat Home should return to when leaving it for another page. */
function rememberHome(state: AppState): AppState["homeSelection"] {
  const selected = state.selected
  return selected.kind === "thread" || selected.kind === "draft" ? selected : state.homeSelection
}

export function createEnvironmentStore(
  environmentId: string
): EnvironmentStore {
  const notificationState = readThreadNotificationState(environmentId)
  const persistSplitView = (view: SplitView | null) =>
    saveSplitView(view, environmentId)
  // How the next change to `selected` is recorded in `navHistory`. "restore" is
  // back/forward itself, which must not add a step.
  let navMode: NavMode | "restore" = "push"
  const withNavMode = (mode: NavMode | "restore", run: () => void) => {
    const previous = navMode
    navMode = mode
    try {
      run()
    } finally {
      navMode = previous
    }
  }
  const store = create<Store>()((set, get) => ({
    environmentId,
    connection: { state: "connecting" },
    info: null,
    providers: readProviderCache(environmentId),
    providersLoading: true,
    settings: null,
    projects: {},
    threads: {},
    transcripts: {},
    runtimeTasks: {},
    threadActivity: {},
    notifications: notificationState.notifications,
    notificationDismissals: notificationState.dismissals,
    diffs: {},
    gitStatuses: {},
    prSelection: null,
    worktreeCleanupThread: null,
    selected: { kind: "none" },
    navHistory: EMPTY_NAV_HISTORY,
    homeSelection: null,
    splitView: readPersistedSplitView(environmentId),
    sidebarOpen: true,
    pullsPanelPeek: false,
    notificationFilter: false,
    rightOpen: false,
    rightTabs: [],
    rightTab: null,
    previews: {},
    openVisualPreview: (threadId, visual) => {
      const state = get()
      const pane = state.splitView ? findThreadPaneByThreadId(state.splitView.root, threadId) : null
      // The dock follows the selected thread, so focus its split pane first.
      if (pane && state.splitView?.focusedPaneId !== pane.id) get().focusSplitPane(pane.id)
      set((current) => {
        const previous = current.previews[threadId]
        const kept = Object.entries(current.previews).filter(([id]) => id !== threadId).slice(-(MAX_DOCK_PREVIEWS - 1))
        const same = previous?.kind === "visual" && previous.visual.id === visual.id
        return {
          previews: { ...Object.fromEntries(kept), [threadId]: same ? previous : { kind: "visual", visual, mode: "rendered" } },
          rightOpen: true,
          rightTab: "preview",
        }
      })
    },
    setPreviewMode: (threadId, mode) => set((current) => {
      const preview = current.previews[threadId]
      return preview?.kind === "visual" && preview.mode !== mode ? { previews: { ...current.previews, [threadId]: { ...preview, mode } } } : {}
    }),
    openWebPreview: (threadId, target, options = {}) => {
      const state = get()
      const pane = state.splitView ? findThreadPaneByThreadId(state.splitView.root, threadId) : null
      if (pane && state.splitView?.focusedPaneId !== pane.id && options.focus !== false) get().focusSplitPane(pane.id)
      set((current) => {
        const previous = current.previews[threadId]
        const web = previous?.kind === "web" ? previous : undefined
        const now = Date.now()
        // An agent request never replaces a page the user just navigated within.
        if (options.requestedByAgent && web && web.entries.length > 0 && web.navigatedAt !== undefined && now - web.navigatedAt < AGENT_PREVIEW_GRACE_MS && !(web.pending)) {
          return { previews: { ...current.previews, [threadId]: { ...web, queued: { input: options.input ?? (target.kind === "file" ? target.path : target.url), title: options.title } } } }
        }
        const base: WebPreview = web ?? emptyWebPreview()
        const entry: WebPreviewEntry = { target, title: options.title }
        const currentEntry = base.entries[base.index]
        let entries = base.entries
        let index = base.index
        if (currentEntry && sameTarget(currentEntry.target, target)) {
          entries = [...entries.slice(0, index), { target, title: options.title ?? currentEntry.title }, ...entries.slice(index + 1)]
        } else {
          entries = [...entries.slice(0, index + 1), entry]
          if (entries.length > MAX_PREVIEW_HISTORY) entries = entries.slice(entries.length - MAX_PREVIEW_HISTORY)
          index = entries.length - 1
        }
        // The page being shown right now is visible, so the tab only needs a dot when it is not.
        const visibleNow = current.selected.kind === "thread" && current.selected.id === threadId && current.rightOpen && current.rightTab === "preview" && options.focus !== false
        const next: WebPreview = {
          ...base,
          entries,
          index,
          revision: base.revision + 1,
          pending: undefined,
          queued: undefined,
          navigatedAt: options.requestedByAgent ? base.navigatedAt : now,
          unseen: options.requestedByAgent && !visibleNow ? true : undefined,
        }
        const others = Object.entries(current.previews).filter(([id]) => id !== threadId).slice(-(MAX_DOCK_PREVIEWS - 1))
        const patch: Partial<AppState> = { previews: { ...Object.fromEntries(others), [threadId]: next } }
        const tabs = current.rightTabs.includes("preview") ? current.rightTabs : [...current.rightTabs, "preview" as const]
        patch.rightOpen = true
        patch.rightTabs = tabs
        // Requests from an agent never move the user's tab when it is elsewhere; the dot says so.
        if (!(options.requestedByAgent && current.rightTab && current.rightTab !== "preview" && current.rightOpen)) patch.rightTab = "preview"
        return patch
      })
    },
    requestPreviewPermission: (threadId, pending, options = {}) => {
      set((current) => {
        const previous = current.previews[threadId]
        const web = previous?.kind === "web" ? previous : emptyWebPreview()
        const others = Object.entries(current.previews).filter(([id]) => id !== threadId).slice(-(MAX_DOCK_PREVIEWS - 1))
        const keepTab = pending.agent && current.rightTab && current.rightTab !== "preview" && current.rightOpen
        return {
          previews: { ...Object.fromEntries(others), [threadId]: { ...web, pending, unseen: pending.agent && (keepTab || options.focus === false) ? true : undefined } },
          rightOpen: true,
          rightTabs: current.rightTabs.includes("preview") ? current.rightTabs : [...current.rightTabs, "preview"],
          rightTab: keepTab ? current.rightTab : "preview",
        }
      })
    },
    clearPreviewPermission: (threadId) => set((current) => {
      const preview = current.previews[threadId]
      return preview?.kind === "web" && preview.pending ? { previews: { ...current.previews, [threadId]: { ...preview, pending: undefined } } } : {}
    }),
    clearQueuedPreview: (threadId) => set((current) => {
      const preview = current.previews[threadId]
      return preview?.kind === "web" && preview.queued ? { previews: { ...current.previews, [threadId]: { ...preview, queued: undefined } } } : {}
    }),
    navigatePreview: (threadId, delta) => set((current) => {
      const preview = current.previews[threadId]
      if (preview?.kind !== "web") return {}
      const index = preview.index + delta
      if (index < 0 || index >= preview.entries.length) return {}
      return { previews: { ...current.previews, [threadId]: { ...preview, index, revision: preview.revision + 1, pending: undefined, navigatedAt: Date.now() } } }
    }),
    setPreviewViewport: (threadId, viewport) => set((current) => {
      const preview = current.previews[threadId]
      if (preview?.kind !== "web") return {}
      const was = preview.viewport
      if (was.mode === viewport.mode && (was.mode === "fill" || (viewport.mode === "device" && was.width === viewport.width && was.height === viewport.height && was.presetId === viewport.presetId))) return {}
      return { previews: { ...current.previews, [threadId]: { ...preview, viewport } } }
    }),
    setPreviewFloating: (threadId, floating, options = {}) => set((current) => {
      const preview = current.previews[threadId]
      if (preview?.kind !== "web" || preview.floating === floating) return {}
      const previews: Record<ThreadId, DockPreview> = {}
      for (const [id, item] of Object.entries(current.previews)) {
        // One floating page at a time: the previous one returns to its thread's dock.
        previews[id] = floating && id !== threadId && item.kind === "web" && item.floating ? { ...item, floating: false } : item
      }
      previews[threadId] = { ...preview, floating }
      // Returning to the panel opens the dock with Preview active.
      if (!floating && options.reveal !== false) {
        return {
          previews,
          rightOpen: true,
          rightTabs: current.rightTabs.includes("preview") ? current.rightTabs : [...current.rightTabs, "preview"],
          rightTab: "preview",
        }
      }
      return { previews }
    }),
    setPreviewTitle: (threadId, title) => set((current) => {
      const preview = current.previews[threadId]
      if (preview?.kind !== "web") return {}
      const entry = preview.entries[preview.index]
      if (!entry || entry.title === title) return {}
      const entries = preview.entries.slice()
      entries[preview.index] = { ...entry, title }
      return { previews: { ...current.previews, [threadId]: { ...preview, entries } } }
    }),
    setPreviewRelay: (threadId, relay) => set((current) => {
      const preview = current.previews[threadId]
      const entry = preview?.kind === "web" ? preview.entries[preview.index] : undefined
      if (preview?.kind !== "web" || !entry || entry.target.kind !== "server" || !!entry.target.relay === relay) return {}
      const entries = preview.entries.slice()
      entries[preview.index] = { ...entry, target: { ...entry.target, relay } }
      return { previews: { ...current.previews, [threadId]: { ...preview, entries, revision: preview.revision + 1 } } }
    }),
    closePreviewPage: (threadId) => set((current) => {
      const preview = current.previews[threadId]
      if (preview?.kind !== "web") return {}
      return { previews: { ...current.previews, [threadId]: { ...emptyWebPreview(), viewport: preview.viewport, revision: preview.revision + 1 } } }
    }),
    markPreviewSeen: (threadId) => set((current) => {
      const preview = current.previews[threadId]
      return preview?.kind === "web" && preview.unseen ? { previews: { ...current.previews, [threadId]: { ...preview, unseen: undefined } } } : {}
    }),
    closePreview: (threadId) => set((current) => {
      const previews = Object.fromEntries(Object.entries(current.previews).filter(([id]) => id !== threadId))
      // The tab belongs to the selected thread; another thread's preview just goes away.
      if (!(current.selected.kind === "thread" && current.selected.id === threadId)) return { previews }
      const remaining = current.rightTabs.filter((tab) => tab !== "preview")
      const index = current.rightTabs.indexOf("preview")
      return {
        previews,
        rightTabs: remaining,
        rightTab: current.rightTab === "preview" ? remaining[Math.min(index, remaining.length - 1)] ?? null : current.rightTab,
      }
    }),
    envOpen: false,
    explorerFile: {},
    terminalTabs: {},
    activeTerminalTab: {},
    expandedWork: {},
    sessionsOpen: false,
    sessionsProjectId: null,
    paletteOpen: false,
    settingsOpen: false,
    settingsTab: "general",
    settingsFocus: null,
    collapsedProjects: {},
    projectOrder: [],
    sidebarFilter: DEFAULT_SIDEBAR_FILTER,
    queued: {},
    heldMessages: {},
    messageRecords: {},
    composerDrafts: {},
    handoffThread: null,
    handoffTarget: null,
    ...readWorkspace(environmentId),

    set: (patch) => set((state) => {
      const next = typeof patch === "function" ? patch(state) : patch
      // Selecting a panel from a shortcut also opens its tab. Merely expanding
      // the dock leaves the user's chosen panels (including none) intact.
      if (next.rightTab && !next.rightTabs && !state.rightTabs.includes(next.rightTab)) {
        return { ...next, rightTabs: [...state.rightTabs, next.rightTab] }
      }
      return next
    }),
    transcript: (id) => get().transcripts[id] ?? emptyThreadState(),
    receiveEvent: (event) => {
      const current = get()
      const notificationDismissals = reconcileNotificationDismissalForEvent(current, event)
      if (notificationDismissals) {
        persistThreadNotificationState(current.notifications, notificationDismissals, current.environmentId)
        current.set({ notificationDismissals })
      }
      current.updateTranscript(event.thread_id, (state) =>
        state.loaded || isThreadVisible(current, event.thread_id) ? applyEvent(state, event) : applyBackgroundEvent(state, event))
    },
    releaseCachedData: () => set((state) => ({
      transcripts: Object.fromEntries(Object.entries(state.transcripts).map(([id, transcript]) => [id, compactThreadState(transcript)])),
      diffs: {}, runtimeTasks: {}, gitStatuses: {},
    })),
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
        const threadChanged = next.thread !== prev.thread
        // Event payloads can contain the thread projection from immediately
        // before that event was assigned a sequence. Keep the client projection
        // at the fold's actual high-water mark so an in-flight snapshot cannot
        // roll it back later.
        if (next.thread && next.thread.last_seq < next.lastSeq) {
          next = { ...next, thread: advanceSequence(next.thread, next.lastSeq) }
        }
        if (next === prev) return {}
        // Keep the event cursor in the transcript. Publishing a new sidebar /
        // composer thread for every token invalidates the entire thread shell.
        // Real metadata changes and hydrated snapshots still publish immediately.
        const threads =
          next.thread && threadChanged
            ? { ...s.threads, [id]: next.thread }
            : s.threads
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
        const next = {
          root: root as SplitView["root"],
          focusedPaneId: target.id,
        }
        persistSplitView(next)
        return { selected: { kind: "thread", id }, splitView: next }
      }),
    selectCreatedThread: (id) => {
      const state = get()
      if (state.selected.kind === "draft") withNavMode("replace", () => state.selectThread(id))
      else state.selectThread(id)
    },
    pushNotification: (threadId, kind, seq, at) =>
      set((state) => {
        if (state.threads[threadId]?.parent_thread_id) return clearNotificationPatch(state, threadId)
        const existing = state.notifications[threadId]
        // Keep the earliest unseen trigger's timestamp but honour the latest kind.
        const notifications = { ...state.notifications, [threadId]: { kind, seq, at: existing?.at ?? at } }
        const dismissal = state.notificationDismissals[threadId]
        const notificationDismissals = { ...state.notificationDismissals }
        if (!dismissal || dismissal.kind !== kind || dismissal.seq < seq) delete notificationDismissals[threadId]
        persistThreadNotificationState(notifications, notificationDismissals, state.environmentId)
        return { notifications, notificationDismissals }
      }),
    clearNotification: (threadId) => set((state) => clearNotificationPatch(state, threadId)),
    dismissAllNotifications: () =>
      set((state) => {
        const current = selectAttentionItems({
          threads: state.threads,
          notifications: state.notifications,
        })
        const notificationDismissals = { ...state.notificationDismissals }
        let changed = Object.keys(state.notifications).length > 0
        for (const item of current) {
          const seq = Math.max(
            threadAttentionSequence(item.thread, item.kind, state.notifications[item.thread.id]),
            state.transcripts[item.thread.id]?.lastSeq ?? 0,
          )
          const previous = notificationDismissals[item.thread.id]
          if (previous?.kind !== item.kind || previous.seq !== seq) changed = true
          notificationDismissals[item.thread.id] = { kind: item.kind, seq }
        }
        if (!changed) return {}
        persistThreadNotificationState({}, notificationDismissals, state.environmentId)
        return { notifications: {}, notificationDismissals }
      }),
    selectDraft: (projectId, purpose) => {
      persistSplitView(null)
      set({
        selected: { kind: "draft", draft: { projectId, ...(purpose ? { purpose } : {}) } },
        splitView: null,
      })
    },
    selectFreeDraft: () => {
      persistSplitView(null)
      set({ selected: { kind: "draft", draft: {} }, splitView: null })
    },
    selectPulls: () => {
      persistSplitView(null)
      set((s) => ({ selected: { kind: "pulls" }, splitView: null, homeSelection: rememberHome(s) }))
    },
    selectUsage: () => {
      persistSplitView(null)
      set((s) => ({ selected: { kind: "usage" }, splitView: null, homeSelection: rememberHome(s) }))
    },
    selectNotes: (noteId) => {
      persistSplitView(null)
      set((s) => ({ selected: noteId ? { kind: "notes", noteId } : { kind: "notes" }, splitView: null, homeSelection: rememberHome(s) }))
    },
    selectTasks: (taskId) => {
      persistSplitView(null)
      set((s) => ({ selected: taskId ? { kind: "tasks", taskId } : { kind: "tasks" }, splitView: null, homeSelection: rememberHome(s) }))
    },
    selectHome: () => {
      const s = get()
      const home = s.homeSelection
      if (s.selected.kind !== "pulls" && s.selected.kind !== "usage" && s.selected.kind !== "notes" && s.selected.kind !== "tasks") return s.selectFreeDraft()
      if (home?.kind === "thread" && s.threads[home.id]?.status !== "archived" && s.threads[home.id]) return s.selectThread(home.id)
      if (home?.kind === "draft" && (!home.draft.projectId || s.projects[home.draft.projectId])) {
        persistSplitView(null)
        return set({ selected: home, splitView: null })
      }
      s.selectFreeDraft()
    },
    replaceNavigation: (select) => withNavMode("replace", select),
    moveNavigation: (delta, isValid) => {
      const move = moveNavHistory(get().navHistory, delta, isValid)
      if (!move) return null
      persistSplitView(null)
      withNavMode("restore", () =>
        set((s) => ({
          navHistory: move.history,
          selected: move.entry,
          splitView: null,
          homeSelection: move.entry.kind === "thread" || move.entry.kind === "draft" ? s.homeSelection : rememberHome(s),
        })),
      )
      return move.entry
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
        selected: threadId
          ? { kind: "thread", id: threadId }
          : { kind: "none" },
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
        selected: threadId
          ? { kind: "thread", id: threadId }
          : { kind: "none" },
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
        // Falling back to a draft is not the user's move: it replaces the thread's step.
        withNavMode("replace", () =>
          set({
            selected: projectId
              ? { kind: "draft", draft: { projectId } }
              : { kind: "none" },
          }),
        )
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
    toggleWork: (turnId) =>
      set((s) => ({
        expandedWork: { ...s.expandedWork, [turnId]: !s.expandedWork[turnId] },
      })),
    toggleProject: (id) =>
      set((s) => ({
        collapsedProjects: {
          ...s.collapsedProjects,
          [id]: !s.collapsedProjects[id],
        },
      })),
    setProjectOrder: (projectOrder) => set({ projectOrder }),
    setSidebarFilter: (filter) => set((s) => ({ sidebarFilter: { ...s.sidebarFilter, ...filter } })),
  }))
  // Every change of the main view is a history step, recorded here rather than
  // at each of the places that select one.
  const startView = navEntryFromSelected(store.getState().selected)
  if (startView) store.setState({ navHistory: recordNavEntry(EMPTY_NAV_HISTORY, startView) })
  store.subscribe((next, previous) => {
    if (navMode === "restore" || next.selected === previous.selected) return
    // Moving between panes of a split view is layout, not navigation.
    if (next.splitView) return
    const entry = navEntryFromSelected(next.selected)
    if (!entry) return
    const navHistory = recordNavEntry(next.navHistory, entry, navMode)
    if (navHistory !== next.navHistory) store.setState({ navHistory })
  })
  // Only persist workspace changes, never every streaming token.
  store.subscribe((next, previous) => {
    if (
      [
        "selected",
        "collapsedProjects",
        "projectOrder",
        "sidebarFilter",
        "explorerFile",
        "expandedWork",
        "composerDrafts",
        "terminalTabs",
        "activeTerminalTab",
        "rightOpen",
        "rightTab",
        "rightTabs",
        "envOpen",
      ].some(
        (key) => next[key as keyof AppState] !== previous[key as keyof AppState]
      )
    ) {
      persistWorkspace(environmentId, next)
    }
  })
  const retain = createRetentionPolicy()
  let pruning = false
  store.subscribe((next, previous) => {
    if (pruning || (next.transcripts === previous.transcripts && next.diffs === previous.diffs && next.selected === previous.selected && next.splitView === previous.splitView)) return
    const patch = retain(next, previous)
    if (patch) { pruning = true; store.setState(patch); pruning = false }
  })
  return store
}

const environmentStores = new Map<string, EnvironmentStore>()
export let useStore = createEnvironmentStore("starting")

export function activateEnvironmentStore(
  environmentId: string
): EnvironmentStore {
  let store = environmentStores.get(environmentId)
  if (!store) {
    store = createEnvironmentStore(environmentId)
    environmentStores.set(environmentId, store)
  }
  if (useStore !== store) useStore.getState().releaseCachedData()
  useStore = store
  return store
}

export function forgetEnvironmentStore(environmentId: string) {
  environmentStores.delete(environmentId)
  try {
    globalThis.localStorage?.removeItem(workspaceKey(environmentId))
  } catch {
    /* best effort */
  }
  saveSplitView(null, environmentId)
}

// ---- selectors ----

/** One cached project list per mounted sidebar section. Transcript deltas keep
 * the metadata table stable, so they need no workspace-wide sort or allocation. */
export function createProjectThreadsSelector(projectId: ProjectId) {
  let previous: AppState["threads"] | undefined
  let result: Thread[] = []
  return (state: AppState) => {
    if (state.threads !== previous) {
      previous = state.threads
      result = selectThreadsForProject(state, projectId)
    }
    return result
  }
}

export const selectThreadsForProject = (
  s: AppState,
  projectId: ProjectId
): Thread[] =>
  Object.values(s.threads)
    .filter((t) => t.project_id === projectId && t.status !== "archived" && !isChildThread(t))
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        b.updated_at.localeCompare(a.updated_at)
    )

export const selectRecentThreads = (s: AppState): Thread[] =>
  Object.values(s.threads)
    .filter((t) => t.status !== "archived" && !isChildThread(t))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))

export const selectSelectedThread = (s: AppState): Thread | null =>
  s.selected.kind === "thread" ? (s.threads[s.selected.id] ?? null) : null

/** Threads shown in this window's panes, ignoring whether the window is on screen. */
export function collectOpenThreadIds(s: Pick<AppState, "selected" | "splitView">): ThreadId[] {
  return collectOpenThreadIdsFromSplit(s.splitView, s.selected.kind === "thread" ? s.selected.id : null)
}

export const isThreadOpen = (s: AppState, threadId: ThreadId): boolean =>
  (s.selected.kind === "thread" && s.selected.id === threadId) ||
  collectSplitThreadIds(s.splitView).includes(threadId)

/** Open in this window and the window still holds transcript DOM/heap. */
export const isThreadVisible = (s: AppState, threadId: ThreadId): boolean =>
  windowHoldsTranscript() && isThreadOpen(s, threadId)

/** The one thread the user is actively interacting with. Other split panes are
 * mounted and visible, but must still accumulate unread completion state. */
export const isThreadFocused = (s: AppState, threadId: ThreadId): boolean =>
  s.selected.kind === "thread" && s.selected.id === threadId

export const selectAvailableProviders = (s: AppState): ProviderStatus[] =>
  s.providers.filter((p) => p.available)

export const isRuntimeTaskActive = (task: RuntimeTask): boolean =>
  task.status === "pending" ||
  task.status === "running" ||
  task.status === "waiting" ||
  task.status === "stopping"

export const selectRuntimeTasks = (
  s: AppState,
  threadId: ThreadId
): RuntimeTask[] => s.runtimeTasks[threadId] ?? []

/** Stable launch order for live work, newest-first for history, with children
 * kept immediately beneath their parent. Metric ticks must not reorder rows. */
export function sortRuntimeTasks(input: RuntimeTask[]): RuntimeTask[] {
  const orderGroup = (tasks: RuntimeTask[], newestFirst: boolean) => {
    const ids = new Set(tasks.map((task) => task.id))
    const children = new Map<string | null, RuntimeTask[]>()
    for (const task of tasks) {
      const parent =
        task.parent_id && ids.has(task.parent_id) ? task.parent_id : null
      const siblings = children.get(parent)
      if (siblings) siblings.push(task)
      else children.set(parent, [task])
    }
    const compare = (left: RuntimeTask, right: RuntimeTask) => {
      const leftSeq = newestFirst ? left.updated_seq : left.started_seq
      const rightSeq = newestFirst ? right.updated_seq : right.started_seq
      const sequence =
        leftSeq > 0 && rightSeq > 0
          ? newestFirst
            ? rightSeq - leftSeq
            : leftSeq - rightSeq
          : 0
      if (sequence) return sequence
      const time = newestFirst
        ? right.updated_at.localeCompare(left.updated_at)
        : left.started_at.localeCompare(right.started_at)
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
    ...orderGroup(
      input.filter((task) => !isRuntimeTaskActive(task)),
      true
    ),
  ]
}

/** Merge an RPC snapshot with live events without letting an older response
 * roll back task progress. Terminal evidence wins timestamp ties. */
export function mergeRuntimeTasks(
  current: RuntimeTask[],
  incoming: RuntimeTask[]
): RuntimeTask[] {
  const merged = new Map(current.map((task) => [task.id, task]))
  for (const incomingTask of incoming) {
    const previous = merged.get(incomingTask.id)
    const task = previous
      ? {
          ...incomingTask,
          started_seq: previous.started_seq || incomingTask.started_seq,
        }
      : incomingTask
    const newerBySequence =
      !!previous && task.updated_seq > previous.updated_seq
    const olderBySequence =
      !!previous &&
      task.updated_seq < previous.updated_seq &&
      (task.updated_seq > 0 || previous.updated_seq > 0)
    const newer =
      !previous ||
      newerBySequence ||
      (!olderBySequence &&
        task.updated_seq === previous.updated_seq &&
        task.updated_at > previous.updated_at)
    const tiedAndNotRegressing =
      !!previous &&
      task.updated_seq === previous.updated_seq &&
      task.updated_at === previous.updated_at &&
      (isRuntimeTaskActive(previous) || !isRuntimeTaskActive(task))
    const terminalRegression =
      !!previous && !isRuntimeTaskActive(previous) && isRuntimeTaskActive(task)
    const explicitReactivation =
      terminalRegression && newerBySequence && task.completed_at == null
    if ((!terminalRegression || explicitReactivation) && (newer || tiedAndNotRegressing))
      merged.set(task.id, task)
  }
  return sortRuntimeTasks([...merged.values()])
}

/** Keep settled turns subscribed only to work they launched. An unrelated
 * process metric must not rebuild their work hierarchy or Markdown props. */
export function createTurnTasksSelector(threadId: ThreadId, turnId: TurnId) {
  let source: RuntimeTask[] | undefined
  let selected: RuntimeTask[] = []
  return (state: { runtimeTasks: Record<ThreadId, RuntimeTask[]> }) => {
    const next = state.runtimeTasks[threadId]
    if (next === source) return selected
    source = next
    const tasks = next?.filter((task) => task.origin_turn_id === turnId) ?? []
    if (tasks.length !== selected.length || tasks.some((task, index) => task !== selected[index])) selected = tasks
    return selected
  }
}

export function summarizeRuntimeTasks(
  threadId: ThreadId,
  tasks: RuntimeTask[]
): ThreadActivitySummary {
  const active = tasks.filter(isRuntimeTaskActive)
  const active_agents = active.filter((task) => task.kind === "agent").length
  const active_processes = active.filter(
    (task) => task.kind === "process"
  ).length
  const active_monitors = active.filter(
    (task) => task.kind === "monitor"
  ).length
  return {
    thread_id: threadId,
    state:
      active_agents > 0
        ? "working"
        : active_processes > 0 || active_monitors > 0
          ? "monitoring"
          : undefined,
    active_agents,
    active_processes,
    active_monitors,
  }
}

export const diffKey = (threadId: ThreadId, turnId?: TurnId | null) =>
  `${threadId}:${turnId ?? "all"}`

// Stateful module: a hot update would drop the live connection, so reload instead.
reloadOnHotUpdate(import.meta.hot)
