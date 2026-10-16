import { environmentEndpoint, onEnvironmentChange, registerEnvironmentConnection } from './shell/environment.ts'
// App state: one daemon connection, the project and thread lists, and the open
// thread's transcript. Transport and transcript folding come from the shared
// `packages/kybern-client` sources, the same ones desktop and mobile use.
import { createContext, createElement, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { KybernClient, type ConnectionStatus } from '../../../packages/kybern-client/src/client.ts'
import {
  applyEvent,
  emptyThreadState,
  seedFromGet,
  type ThreadState,
} from '../../../packages/kybern-client/src/transcript.ts'
import { isChildThread } from '../../../packages/kybern-client/src/subagents.ts'
import type { Project, Thread, ThreadEvent, ThreadId } from '../../../packages/kybern-client/src/types.ts'

export interface AppState {
  status: ConnectionStatus
  statusDetail: string | null
  projects: Project[]
  threads: Thread[]
  /** `null` shows the home (Draft) screen. */
  selectedId: ThreadId | null
  /**
   * What the home screen starts while no thread is selected (desktop
   * `selected.kind === "draft"`): a project's new thread, its coordinator, or
   * a free chat when `projectId` is unset.
   */
  draft: { projectId?: string; purpose?: 'thread' | 'coordinator' }
  open: ThreadState
  collapsed: Record<string, boolean>
  sidebarOpen: boolean
  /** The project and thread lists have arrived at least once (the Welcome screen waits for them). */
  listsLoaded: boolean
}

let state: AppState = {
  status: 'idle',
  statusDetail: null,
  projects: [],
  threads: [],
  selectedId: null,
  draft: {},
  open: emptyThreadState(),
  collapsed: {},
  sidebarOpen: true,
  listsLoaded: false,
}
const listeners = new Set<() => void>()

export interface PaneState {
  selectedId: ThreadId | null
  open: ThreadState
  draft: AppState['draft']
  generation: number
}
export const DEFAULT_PANE = 'main'
let focusedPaneId = DEFAULT_PANE
const panes = new Map<string, PaneState>([[DEFAULT_PANE, { selectedId: null, open: state.open, draft: {}, generation: 0 }]])
const PaneContext = createContext<{ id: string; snapshot?: AppState; compact?: boolean } | null>(null)
export function PaneProvider({ id, snapshot, compact, children }: { id: string; snapshot?: AppState; compact?: boolean; children: ReactNode }) {
  const inherited = useContext(PaneContext)?.compact
  const small = compact ?? inherited
  const value = useMemo(() => ({ id, snapshot, compact: small }), [id, snapshot, small])
  return createElement(PaneContext.Provider, { value }, children)
}
export function usePaneCompact() { return !!useContext(PaneContext)?.compact }
export function usePaneId() { return useContext(PaneContext)?.id ?? focusedPaneId }
export function useFrozenPane() { return !!useContext(PaneContext)?.snapshot }
export const getFocusedPaneId = () => focusedPaneId
export const getPane = (id: string) => panes.get(id)
export const getPaneIds = () => [...panes.keys()]
export function getPaneState(id: string): AppState {
  const pane = panes.get(id)
  return pane ? { ...state, ...pane } : { ...state, selectedId: null, open: emptyThreadState(), draft: {} }
}
/** Capture the pane at render time; async callbacks never retarget on focus changes. */
export function usePaneAccess() {
  const context = useContext(PaneContext)
  const id = context?.id ?? focusedPaneId
  return useMemo(() => ({ id, get: () => context?.snapshot ?? getPaneState(id), frozen: !!context?.snapshot }), [id, context])
}
function emit() { for (const listener of listeners) listener() }
function mirrorFocus() {
  const pane = panes.get(focusedPaneId)!
  state = { ...state, selectedId: pane.selectedId, open: pane.open, draft: pane.draft }
}
export function createPane(id: string) {
  if (!panes.has(id)) panes.set(id, { selectedId: null, open: emptyThreadState(), draft: {}, generation: 0 })
}
export function focusPane(id: string) {
  if (!panes.has(id) || focusedPaneId === id) return
  focusedPaneId = id
  mirrorFocus(); emit()
}
export function setPane(id: string, patch: Partial<PaneState>) {
  const pane = panes.get(id)
  if (!pane) return
  const next = { ...pane, ...patch }
  panes.set(id, next)
  if (patch.open && next.selectedId) {
    const session = sessions.get(next.selectedId)
    if (session) session.open = patch.open
    for (const [otherId, other] of panes) if (otherId !== id && other.selectedId === next.selectedId) panes.set(otherId, { ...other, open: patch.open })
  }
  mirrorFocus(); emit()
}
/** Legacy callers continue addressing the focused pane. */
export function set(patch: Partial<AppState>) {
  state = { ...state, ...patch }
  setPane(focusedPaneId, {
    ...(patch.selectedId !== undefined ? { selectedId: patch.selectedId } : {}),
    ...(patch.open !== undefined ? { open: patch.open } : {}),
    ...(patch.draft !== undefined ? { draft: patch.draft } : {}),
  })
}
export function useApp<T>(select: (s: AppState) => T): T {
  const context = useContext(PaneContext)
  return useSyncExternalStore(subscribe, () => select(context?.snapshot ?? (context ? getPaneState(context.id) : state)))
}
export const usePane = useApp
export const getState = () => state

/** Observe every state change (navigation history, persistence). */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}


let client: KybernClient | null = null
/** The daemon connection, once `connect()` has run. */
export const getClient = () => client
type Session = { open: ThreadState; stop?: () => void; ready?: Promise<void> }
const sessions = new Map<ThreadId, Session>()
function releaseUnused() {
  for (const [id, session] of sessions) if (![...panes.values()].some(p => p.selectedId === id)) {
    sessions.delete(id); session.stop?.()
  }
}
export function closePaneState(id: string) {
  if (panes.size <= 1 || !panes.has(id)) return
  panes.delete(id); releaseUnused()
  if (focusedPaneId === id) focusedPaneId = panes.keys().next().value!
  mirrorFocus(); emit()
}
/** Identity token for asynchronous paging/tool hydration across close/reopen. */
export const getThreadSession = (id: string) => sessions.get(id)
export async function reloadPaneThread(paneId: string, threadId: string) {
  sessions.get(threadId)?.stop?.(); sessions.delete(threadId)
  return selectPaneThread(paneId, threadId)
}
export function getThreadOpen(id: string) { return sessions.get(id)?.open ?? [...panes.values()].find(p => p.selectedId === id)?.open }
export function setThreadOpen(id: string, open: ThreadState) {
  const session = sessions.get(id)
  if (session) session.open = open
  for (const [paneId, pane] of panes) if (pane.selectedId === id) panes.set(paneId, { ...pane, open })
  mirrorFocus(); emit()
}

/** Drop a dead client so `connect()` builds a fresh one, re-reading the port and token files. */
let connectionAttempt = 0
export function resetClient() {
  connectionAttempt++
  for (const session of sessions.values()) session.stop?.()
  sessions.clear()
  for (const [id, pane] of panes) panes.set(id, { ...pane, open: emptyThreadState(), generation: pane.generation + 1 })
  mirrorFocus(); emit()
  const previous = client
  client = null
  clearTimeout(retryTimer); refreshing = null; refreshAgain = false
  previous?.close()
}

export async function connect() {
  if (client) return
  const attempt = ++connectionAttempt
  let ep
  try {
    const endpoint = environmentEndpoint()
    ep = endpoint instanceof Promise ? await endpoint : endpoint
    if (attempt !== connectionAttempt) return
  } catch (error) {
    if (attempt !== connectionAttempt) return
    set({ status: 'failed', statusDetail: error instanceof Error ? error.message : 'Start kybernd, then reconnect' })
    return
  }
  // Native sockets authenticate the upgrade with a header and use the trusted
  // app origin, like the mobile client's `createNativeSocket`.
  client = new KybernClient(ep, {
    createSocket: (url, token) =>
      new WebSocket(url, {
        headers: { origin: 'tauri://localhost', Authorization: `Bearer ${token}` },
      } as unknown as string[]),
  })
  const owner = client
  client.onStatus((status, detail) => {
    if (owner !== client) return
    set({ status, statusDetail: detail ?? null })
    if (status === 'open') void refreshLists()
  })
  client.onNotification('projects.changed', () => void refreshLists())
  client.onNotification('threads.changed', () => void refreshLists())
  client.connect()
}

let refreshing: Promise<void> | null = null
let refreshAgain = false
let retryTimer: ReturnType<typeof setTimeout> | undefined

/**
 * Reload the project and thread lists. Calls that arrive while one is in flight
 * (a burst of `threads.changed` from busy agents) fold into a single rerun, so a
 * slow daemon gets at most one list request at a time. A failed first load
 * retries after 3 s instead of leaving the window on "Connecting".
 */
export function refreshLists(): Promise<void> {
  if (refreshing) {
    refreshAgain = true
    return refreshing
  }
  const owner = client
  refreshing = (async () => {
    try {
      do {
        refreshAgain = false
        await loadLists()
      } while (refreshAgain && owner === client)
    } catch {
      if (owner !== client) return
      clearTimeout(retryTimer)
      if (!state.listsLoaded && client?.status === 'open') retryTimer = setTimeout(() => void refreshLists(), 3000)
    } finally {
      if (owner !== client) return
      refreshing = null
      // A request that arrived while a failing load was in flight (say, from a
      // reconnect) still runs once the connection is open.
      if (refreshAgain && client?.status === 'open') {
        refreshAgain = false
        void refreshLists()
      }
    }
  })()
  return refreshing
}

async function loadLists() {
  if (!client) return
  const owner = client
  const [p, t] = await Promise.all([
    owner.call('projects.list', {}),
    owner.call('threads.list', {}),
  ])
  if (owner !== client) return
  const threads = t.threads
    .filter((th) => !isChildThread(th) && th.status !== 'archived')
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated_at.localeCompare(a.updated_at))
  set({ projects: p.projects, threads, listsLoaded: true })
  for (const [paneId, pane] of panes) if (pane.selectedId && !pane.open.loaded && !sessions.has(pane.selectedId)) void selectPaneThread(paneId, pane.selectedId).catch(error => console.error('[pane] Unable to load thread:', error))
  const want = process.env.KYBERN_GPUIX_THREAD
  if (want && !state.selectedId) {
    const match = threads.find((th) => th.id === want || th.title.toLowerCase().includes(want.toLowerCase()))
    if (match) void selectThread(match.id)
  }
}

const openEventListeners = new Set<(event: ThreadEvent) => void>()
/** Observe the open thread's live events after they are folded in (earlier-history replay). */
export function onOpenEvent(listener: (event: ThreadEvent) => void): () => void {
  openEventListeners.add(listener)
  return () => openEventListeners.delete(listener)
}

export function selectThread(id: ThreadId | null) { return selectPaneThread(focusedPaneId, id) }
export async function selectPaneThread(paneId: string, id: ThreadId | null) {
  const pane = panes.get(paneId)
  if (!pane) return
  const generation = pane.generation + 1
  // A repeat explicit selection refreshes a sole owner, retaining race protection.
  if (id && pane.selectedId === id && ![...panes].some(([key, p]) => key !== paneId && p.selectedId === id)) {
    sessions.get(id)?.stop?.(); sessions.delete(id)
  }
  const existing = id ? sessions.get(id) : undefined
  setPane(paneId, { selectedId: id, open: existing?.open ?? emptyThreadState(), generation })
  releaseUnused()
  if (!id || !client) return
  if (existing) { await existing.ready; return }
  const owner = client
  const session: Session = { open: emptyThreadState() }
  sessions.set(id, session)
  const valid = () => owner === client && sessions.get(id) === session
  session.ready = (async () => {
    const res = await owner.call('threads.get', { thread_id: id, transcript_limit: 120, include_tool_output: false })
    if (!valid()) return
    setThreadOpen(id, seedFromGet(res))
    const sub = owner.subscribeEvents(
      { thread_id: id, after_seq: res.thread.last_seq, include_tool_output: false },
      event => {
        if (!valid()) return
        setThreadOpen(id, applyEvent(session.open, event))
        for (const listener of threadEventListeners) listener(id, event)
        if (state.selectedId === id) for (const listener of openEventListeners) listener(event)
      },
    )
    session.stop = () => sub.unsubscribe()
  })()
  try { await session.ready } catch (error) {
    if (valid()) { sessions.delete(id); throw error }
  }
}
const threadEventListeners = new Set<(id: string, event: ThreadEvent) => void>()
export function onThreadEvent(listener: (id: string, event: ThreadEvent) => void) {
  threadEventListeners.add(listener)
  return () => { threadEventListeners.delete(listener) }
}

export async function send(text: string) { return sendFromPane(focusedPaneId, text) }
export async function sendFromPane(paneId: string, text: string) {
  const state = getPaneState(paneId)
  const generation = getPane(paneId)?.generation
  const body = text.trim()
  if (!body || !client) return
  const message = { parts: [{ type: 'text' as const, text: body }] }
  if (state.selectedId) {
    await client.call('threads.send', { thread_id: state.selectedId, message })
    return
  }
  // Home: start a thread in the draft's project, or a free chat (desktop `createThread`).
  const recent = state.threads[0]
  const owner = client
  const created = await owner.call('threads.create', {
    ...(state.draft.projectId ? { project_id: state.draft.projectId } : {}),
    provider: recent?.provider ?? { kind: 'claude-code', instance: 'default' },
    message,
  })
  if (owner !== client) return
  await refreshLists()
  if (owner === client && getPane(paneId)?.generation === generation) void selectPaneThread(paneId, created.id)
}

/** Show the home screen for a project's new thread (or a free chat without one). */
export function selectDraft(projectId?: string, purpose?: 'thread' | 'coordinator') {
  set({ draft: { ...(projectId ? { projectId } : {}), ...(purpose ? { purpose } : {}) } })
  void selectThread(null)
}

export function toggleProject(id: string) {
  set({ collapsed: { ...state.collapsed, [id]: !state.collapsed[id] } })
}

export function toggleSidebar() {
  set({ sidebarOpen: !state.sidebarOpen })
}

registerEnvironmentConnection({ close: resetClient, connect })
onEnvironmentChange(() => { panes.clear(); focusedPaneId = DEFAULT_PANE; createPane(DEFAULT_PANE); clearTimeout(retryTimer); refreshing = null; refreshAgain = false; set({ status: 'connecting', statusDetail: null, projects: [], threads: [], selectedId: null, draft: {}, open: emptyThreadState(), collapsed: {}, listsLoaded: false }) }, -60)
