// App state: one daemon connection, the project and thread lists, and the open
// thread's transcript. Transport and transcript folding come from the shared
// `packages/kybern-client` sources, the same ones desktop and mobile use.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { useSyncExternalStore } from 'react'
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

/** Merge a patch into app state and notify subscribers. */
export function set(patch: Partial<AppState>) {
  state = { ...state, ...patch }
  for (const l of listeners) l()
}

export function useApp<T>(select: (s: AppState) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => select(state),
  )
}

export const getState = () => state

/** Observe every state change (navigation history, persistence). */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function endpoint() {
  if (process.env.KYBERN_URL && process.env.KYBERN_TOKEN)
    return { url: process.env.KYBERN_URL, token: process.env.KYBERN_TOKEN }
  const dir = process.env.KYBERN_DATA_DIR ?? path.join(homedir(), '.kybern')
  const port = readFileSync(path.join(dir, 'daemon.port'), 'utf8').trim()
  const token = readFileSync(path.join(dir, 'daemon.token'), 'utf8').trim()
  return { url: `ws://127.0.0.1:${port}/ws`, token }
}

let client: KybernClient | null = null
/** The daemon connection, once `connect()` has run. */
export const getClient = () => client
let unsubscribeOpen: (() => void) | null = null

/** Drop a dead client so `connect()` builds a fresh one, re-reading the port and token files. */
export function resetClient() {
  client?.close()
  client = null
  unsubscribeOpen?.()
  unsubscribeOpen = null
}

export function connect() {
  if (client) return
  let ep
  try {
    ep = endpoint()
  } catch {
    set({ status: 'failed', statusDetail: 'Start kybernd, then reopen this window' })
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
  client.onStatus((status, detail) => {
    set({ status, statusDetail: detail ?? null })
    if (status === 'open') void refreshLists()
  })
  client.onNotification('projects.changed', () => void refreshLists())
  client.onNotification('threads.changed', () => void refreshLists())
  client.connect()
}

export async function refreshLists() {
  if (!client) return
  const [p, t] = await Promise.all([
    client.call('projects.list', {}),
    client.call('threads.list', {}),
  ])
  const threads = t.threads
    .filter((th) => !isChildThread(th) && th.status !== 'archived')
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated_at.localeCompare(a.updated_at))
  set({ projects: p.projects, threads, listsLoaded: true })
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

export async function selectThread(id: ThreadId | null) {
  unsubscribeOpen?.()
  unsubscribeOpen = null
  set({ selectedId: id, open: emptyThreadState() })
  if (!id || !client) return
  const res = await client.call('threads.get', {
    thread_id: id,
    transcript_limit: 120,
    include_tool_output: false,
  })
  if (state.selectedId !== id) return
  set({ open: seedFromGet(res) })
  const sub = client.subscribeEvents(
    { thread_id: id, after_seq: res.thread.last_seq, include_tool_output: false },
    (event) => {
      if (state.selectedId !== id) return
      set({ open: applyEvent(state.open, event) })
      for (const listener of openEventListeners) listener(event)
    },
  )
  unsubscribeOpen = () => sub.unsubscribe()
}

export async function send(text: string) {
  const body = text.trim()
  if (!body || !client) return
  const message = { parts: [{ type: 'text' as const, text: body }] }
  if (state.selectedId) {
    await client.call('threads.send', { thread_id: state.selectedId, message })
    return
  }
  // Home: start a thread in the draft's project, or a free chat (desktop `createThread`).
  const recent = state.threads[0]
  const created = await client.call('threads.create', {
    ...(state.draft.projectId ? { project_id: state.draft.projectId } : {}),
    provider: recent?.provider ?? { kind: 'claude-code', instance: 'default' },
    message,
  })
  await refreshLists()
  void selectThread(created.id)
}

/** Show the home screen for a project's new thread (or a free chat without one). */
export function selectDraft(projectId?: string, purpose?: 'thread' | 'coordinator') {
  set({ draft: { ...(projectId ? { projectId } : {}), ...(purpose ? { purpose } : {}) } })
  if (state.selectedId !== null) void selectThread(null)
}

export function toggleProject(id: string) {
  set({ collapsed: { ...state.collapsed, [id]: !state.collapsed[id] } })
}

export function toggleSidebar() {
  set({ sidebarOpen: !state.sidebarOpen })
}
