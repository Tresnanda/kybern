import { onEnvironmentChange } from '../shell/environment.ts'
// Navigation and sidebar state that the thread panel, rail and title bar share:
// the page on screen, back/forward history, the open overlays, live child
// threads and activity, and the reader's sidebar preferences. App state
// (projects, threads, the open thread) stays in `state.ts`.
import { useSyncExternalStore } from 'react'
import type { ThreadPending } from '../../../../packages/kybern-client/src/threadAttention.ts'
import type {
  ProviderKind,
  ProviderLimits,
  ProviderStatus,
  Thread,
  ThreadActivityState,
  ThreadId,
} from '../../../../packages/kybern-client/src/types.ts'

/** Rail destinations (`views/NavRail.tsx`). Settings is an overlay, not a page. */
export type Page = 'home' | 'notes' | 'tasks' | 'pulls' | 'usage'

/** A view the reader can go back to (`state/navHistory.ts` `NavEntry`). */
export type NavEntry =
  | { kind: 'thread'; id: ThreadId }
  | { kind: 'draft'; draft: { projectId?: string; purpose?: 'thread' | 'coordinator' } }
  | { kind: 'pulls' }
  | { kind: 'usage' }
  | { kind: 'notes' }
  | { kind: 'tasks' }

export interface NavHistory {
  /** Oldest first. */
  readonly entries: readonly NavEntry[]
  /** The entry on screen, or -1 before the first view. */
  readonly index: number
}

/** `state/sidebarOrganize.ts` `SidebarFilter`. */
export interface SidebarFilter {
  threads: 'all' | 'pinned' | 'working'
  agent: ProviderKind | null
}

export interface NavState {
  page: Page
  settingsOpen: boolean
  /** Pull requests hide the thread panel; ⌘B peeks it there. */
  pullsPeek: boolean
  /** The last panel toggle came from the keyboard: it changes without motion. */
  panelInstant: boolean
  /** The last change came from a window shortcut (⌘K, ⌘N, ⌘[, ⌘], ⌘↑, ⌘,), not the
   *  pointer: what it opens or switches appears without motion. A press resets it. */
  keyboardNav: boolean
  history: NavHistory
  paletteOpen: boolean
  /** The Resume session dialog, scoped to a project or all of them. */
  sessions: { projectId: string | null } | null
  /** The Hand off dialog for a thread, with the agent picked in the menu. */
  handoff: { threadId: ThreadId; target: ProviderKind | null } | null
  /** Provider subagent and delegated child threads, which `threads.list` leaves out. */
  children: Record<ThreadId, Thread>
  activity: Record<ThreadId, ThreadActivityState>
  /** What a thread's own waiting request asks for, and what its delegated agents wait on (`threads.list` activity). */
  pending: Record<ThreadId, ThreadPending>
  /** Turns that finished while the reader looked elsewhere (desktop "done" notifications). */
  unread: Record<ThreadId, true>
  /** Child rows the reader dismissed, or that finished and left. */
  dismissed: Record<ThreadId, true>
  providers: ProviderStatus[]
  /** `providers.list` has answered once for this daemon (it probes every agent CLI and can take seconds). */
  providersLoaded: boolean
  limits: ProviderLimits[]
  limitsRefreshing: ProviderKind[]
  filter: SidebarFilter
  /** The bell: only threads that need attention. */
  attentionFilter: boolean
  /** "Dismiss all": the event sequence each waiting or failed thread was dismissed at. */
  attentionDismissals: Record<ThreadId, number>
  /** The reader's project order; projects it does not name follow alphabetically. */
  projectOrder: string[]
  /** The sidebar lists one machine's threads when set (the "All machines" filter); null lists them all. Per window. */
  machineFilter: string | null
  /** Composer drafts by desktop key: `thread:<id>`, `project:<id>:…`, `free:main`. */
  composerDrafts: Record<string, true>
  version: string | null
  /** The active space (`spaces/current.ts`); null until one is chosen or the daemon has none. */
  spaceId: string | null
  /** The last view of each space, restored when switching back. */
  spaceViews: Record<string, NavEntry>
}

export const DEFAULT_FILTER: SidebarFilter = { threads: 'all', agent: null }

const initialNav: NavState = {
  page: 'home',
  settingsOpen: false,
  pullsPeek: false,
  panelInstant: false,
  keyboardNav: false,
  history: { entries: [], index: -1 },
  paletteOpen: false,
  sessions: null,
  handoff: null,
  children: {},
  activity: {},
  pending: {},
  unread: {},
  dismissed: {},
  providers: [],
  providersLoaded: false,
  limits: [],
  limitsRefreshing: [],
  filter: DEFAULT_FILTER,
  attentionFilter: false,
  attentionDismissals: {},
  projectOrder: [],
  machineFilter: null,
  composerDrafts: {},
  version: null,
  spaceId: null,
  spaceViews: {},
}
let nav = initialNav
const listeners = new Set<() => void>()

export const getNav = () => nav

export function setNav(patch: Partial<NavState> | ((s: NavState) => Partial<NavState>)) {
  const next = typeof patch === 'function' ? patch(nav) : patch
  let changed = false
  for (const key in next) if (next[key as keyof NavState] !== nav[key as keyof NavState]) changed = true
  if (!changed) return
  nav = { ...nav, ...next }
  for (const l of listeners) l()
}

/** A pointer press: later navigation and overlays animate again (`keyboardNav`). */
export function pointerNav() {
  if (nav.keyboardNav) setNav({ keyboardNav: false })
}

export function subscribeNav(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useNav<T>(select: (s: NavState) => T): T {
  return useSyncExternalStore(subscribeNav, () => select(nav))
}

/** For the composer: mark or clear an unsent draft so the sidebar shows its pencil. */
export function setComposerDraft(key: string, present: boolean) {
  if (!!nav.composerDrafts[key] === present) return
  const composerDrafts = { ...nav.composerDrafts }
  if (present) composerDrafts[key] = true
  else delete composerDrafts[key]
  setNav({ composerDrafts })
}

onEnvironmentChange(() => setNav({ ...initialNav }), -50)
