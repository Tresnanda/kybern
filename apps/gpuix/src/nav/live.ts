import { environmentKey, onEnvironmentChange } from '../shell/environment.ts'
// Keeps the thread panel live, like the desktop's `state/rpc.ts`:
//
// - one events subscription for every thread folds `thread_created`,
//   `thread_updated` and `thread_archived` into the lists, so status glyphs,
//   pins, titles and new threads appear without a refetch;
// - provider subagents and delegated children (left out of `threads.list`) are
//   fetched per parent while it has agents at work, and then follow events;
// - background activity (working, monitoring) comes from `threads.list`, re-read
//   shortly after runtime tasks change;
// - a turn that completes while its thread is not open marks it unread;
// - plan limits follow `usage.limits` and `usage.limits.changed`.
//
// Text deltas cost one switch here and nothing else: no state changes, no render.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { isChildThread } from '../../../../packages/kybern-client/src/subagents.ts'
import {
  USAGE_LIMITS_CHANGED_NOTIFICATION,
  type Thread,
  type ThreadActivitySummary,
  type ThreadEvent,
  type ThreadId,
  type UsageLimitsResult,
} from '../../../../packages/kybern-client/src/types.ts'
import { getClient, getState, onThreadActivity, set, subscribe } from '../state.ts'
import { DEFAULT_FILTER, getNav, setNav, subscribeNav, type NavState } from './store.ts'

const LIMITS_POLL_MS = 60_000
const ACTIVITY_DEBOUNCE_MS = 600

const byRecent = (a: Thread, b: Thread) => Number(b.pinned) - Number(a.pinned) || b.updated_at.localeCompare(a.updated_at)

/** Fields a sidebar row shows; children re-render only when one of these changes (`state/subagents.ts` `sidebarKey`). */
const childKey = (t: Thread) =>
  `${t.id}|${t.title}|${t.status}|${t.parent_thread_id ?? ''}|${t.provider.kind}|${t.subagent?.status}|${t.subagent?.started_at}|${t.subagent?.completed_at ?? ''}|${t.delegation?.status ?? ''}|${t.delegation?.started_at ?? ''}|${t.delegation?.completed_at ?? ''}`

/** Fields the panel, title bar and palette show for a top-level thread. */
const threadKey = (t: Thread) =>
  `${t.title}|${t.status}|${t.pinned}|${t.updated_at}|${t.project_id}|${t.coordinator_project_id ?? ''}|${t.worktree?.branch ?? ''}|${t.provider.kind}|${t.model ?? ''}|${t.effort ?? ''}|${t.permission_mode}`

/** Threads archived here or by an event: a late `thread_updated` must not bring their rows back. */
const archived = new Set<ThreadId>()
export function markArchived(id: ThreadId) {
  archived.add(id)
}

function upsertThread(thread: Thread) {
  if (thread.status === 'archived') archived.add(thread.id)
  else if (archived.has(thread.id)) return
  if (isChildThread(thread)) {
    const children = getNav().children
    const current = children[thread.id]
    if (thread.status === 'archived') {
      if (!current) return
      const next = { ...children }
      delete next[thread.id]
      return setNav({ children: next })
    }
    if (current && childKey(current) === childKey(thread)) {
      // Progress only: keep the newest object without waking the panel.
      children[thread.id] = thread
      return
    }
    return setNav({ children: { ...children, [thread.id]: thread } })
  }
  const threads = getState().threads
  const index = threads.findIndex((t) => t.id === thread.id)
  if (index >= 0 && threads[index]!.last_seq > thread.last_seq) return
  // An update that changes nothing the lists show keeps the same array: no commit, no layout.
  if (index >= 0 && threadKey(threads[index]!) === threadKey(thread)) return
  if (thread.status === 'archived') {
    if (index >= 0) set({ threads: threads.filter((t) => t.id !== thread.id) })
    return
  }
  const next = index >= 0 ? threads.map((t) => (t.id === thread.id ? thread : t)) : [thread, ...threads]
  set({ threads: next.sort(byRecent) })
}

/** Other surfaces that follow every thread event (agent toasts). */
const eventTaps = new Set<(event: ThreadEvent) => void>()
export function onLiveEvent(listener: (event: ThreadEvent) => void): () => void {
  eventTaps.add(listener)
  return () => eventTaps.delete(listener)
}

function onEvent(event: ThreadEvent) {
  for (const tap of eventTaps) tap(event)
  switch (event.kind) {
    case 'thread_created':
    case 'thread_updated':
      return upsertThread(event.thread)
    case 'thread_archived': {
      archived.add(event.thread_id)
      const threads = getState().threads
      if (threads.some((t) => t.id === event.thread_id)) set({ threads: threads.filter((t) => t.id !== event.thread_id) })
      if (getNav().children[event.thread_id]) {
        const children = { ...getNav().children }
        delete children[event.thread_id]
        setNav({ children })
      }
      return
    }
    case 'turn_completed': {
      // A finished turn the reader did not watch (desktop `announce` → "done").
      if (event.stop_reason !== 'completed') return
      const thread = getState().threads.find((t) => t.id === event.thread_id)
      if (!thread || thread.parent_thread_id || getState().selectedId === event.thread_id) return
      if (!getNav().unread[event.thread_id]) setNav({ unread: { ...getNav().unread, [event.thread_id]: true } })
      return
    }
    case 'runtime_task_started':
    case 'runtime_task_updated':
    case 'runtime_task_completed':
      if (event.task.kind === 'agent' && event.kind === 'runtime_task_started') void loadChildren(event.thread_id)
      scheduleActivity()
      return
  }
}

const childLoads = new Map<ThreadId, Promise<void>>()
/** A thread's subagent and delegated children (`loadSubagents`). Live changes arrive as events. */
function loadChildren(parentId: ThreadId): Promise<void> {
  const pending = childLoads.get(parentId)
  if (pending) return pending
  const client = getClient()
  if (!client) return Promise.resolve()
  const request = client
    .call('threads.list', { parent_thread_id: parentId })
    .then((result) => {
      if (getClient() !== client) return
      let changed = false
      const children = { ...getNav().children }
      for (const thread of result.threads) {
        if (!isChildThread(thread) || thread.status === 'archived') continue
        const current = children[thread.id]
        if (current && current.last_seq > thread.last_seq) continue
        if (!current || childKey(current) !== childKey(thread)) changed = true
        children[thread.id] = thread
      }
      if (changed) setNav({ children })
    })
    .catch(() => {})
    .finally(() => childLoads.delete(parentId))
  childLoads.set(parentId, request)
  return request
}

function applyActivity(summaries: ThreadActivitySummary[] | undefined) {
  const activity: NavState['activity'] = {}
  for (const summary of summaries ?? []) {
    if (summary.state) activity[summary.thread_id] = summary.state
    if (summary.active_agents > 0) void loadChildren(summary.thread_id)
  }
  const current = getNav().activity
  const same =
    Object.keys(activity).length === Object.keys(current).length &&
    Object.entries(activity).every(([id, value]) => current[id] === value)
  if (!same) setNav({ activity })
}

let activityTimer: ReturnType<typeof setTimeout> | undefined
function scheduleActivity() {
  clearTimeout(activityTimer)
  activityTimer = setTimeout(() => void refreshActivity(), ACTIVITY_DEBOUNCE_MS)
}

async function refreshActivity() {
  const client = getClient()
  if (!client) return
  try {
    const result = await client.call('threads.list', {})
    if (getClient() === client) applyActivity(result.activity)
  } catch {
    // The next runtime task change tries again.
  }
}

export async function loadProviders(forceRefresh = false) {
  const client = getClient()
  if (!client) return []
  const result = await client.call('providers.list', forceRefresh ? { force_refresh: true } : {})
  if (getClient() === client) setNav({ providers: result.providers, providersLoaded: true })
  return result.providers
}

function applyLimits(result: UsageLimitsResult) {
  setNav({ limits: result.providers, limitsRefreshing: result.refreshing ?? [] })
}

/** Ask the daemon for plan limits; `refresh` re-reads every provider now (the card does on open). */
export function askLimits(refresh = false) {
  const client = getClient()
  if (!client) return
  void client.call('usage.limits', { cached: true, ...(refresh ? { refresh: true } : {}) }).then((result) => { if (getClient() === client) applyLimits(result) }, () => {})
}

// ---- the reader's sidebar preferences, kept across launches per daemon ----

/** The sidebar-preferences file of an environment key (`environmentKey()`), so forgetting an environment can remove it. */
export const prefsFileFor = (key: string) => path.join(
  process.env.KYBERN_CLIENT_CONFIG_DIR ?? path.join(homedir(), 'Library/Application Support/kybern-gpuix'),
  `workspace-${createHash('sha1').update(key).digest('hex').slice(0, 12)}.json`,
)
const prefsFile = () => prefsFileFor(environmentKey())

interface Prefs {
  collapsed?: Record<string, boolean>
  projectOrder?: string[]
  filter?: NavState['filter']
  sidebarOpen?: boolean
  unread?: NavState['unread']
  attentionDismissals?: NavState['attentionDismissals']
}

function readPrefs(): Prefs {
  try {
    return JSON.parse(readFileSync(prefsFile(), 'utf8')) as Prefs
  } catch {
    return {}
  }
}

let prefsTimer: ReturnType<typeof setTimeout> | undefined
let lastPrefs = ''
let pendingPrefs: (() => void) | undefined
let stops: (() => void)[] = []
function persistPrefs() {
  const prefs: Prefs = {
    collapsed: getState().collapsed,
    projectOrder: getNav().projectOrder,
    filter: getNav().filter,
    sidebarOpen: getState().sidebarOpen,
    unread: getNav().unread,
    attentionDismissals: getNav().attentionDismissals,
  }
  const text = JSON.stringify(prefs)
  if (text === lastPrefs) return
  lastPrefs = text
  clearTimeout(prefsTimer)
  const target = prefsFile()
  pendingPrefs = () => {
    try {
      mkdirSync(path.dirname(target), { recursive: true })
      const temp = `${target}.${process.pid}.tmp`
      writeFileSync(temp, text)
      renameSync(temp, target)
    } catch {
      // Preferences are a convenience; a read-only home must not break the app.
    }
  }
  prefsTimer = setTimeout(() => { pendingPrefs?.(); pendingPrefs = undefined }, 300)
}

process.on('exit', () => pendingPrefs?.())

let started = false
let owner: ReturnType<typeof getClient> = null
let limitsTimer: ReturnType<typeof setInterval> | undefined
/** Follow a fresh client after a reconnect (`shell/connection.ts`). */
export function restartLive() {
  stopLive()
  startLive()
}

/** Start following the daemon. Called once by the app shell, after `connect()`. */
export function startLive() {
  const client = getClient()
  if (!client) return
  if (started && owner === client) return
  if (started) stopLive()
  owner = client
  started = true

  const prefs = readPrefs()
  lastPrefs = JSON.stringify(prefs)
  set({ collapsed: prefs.collapsed ?? {}, ...(prefs.sidebarOpen === undefined ? {} : { sidebarOpen: prefs.sidebarOpen }) })
  setNav({ projectOrder: prefs.projectOrder ?? [], filter: prefs.filter ?? DEFAULT_FILTER, unread: prefs.unread ?? {}, attentionDismissals: prefs.attentionDismissals ?? {} })
  stops.push(subscribe(persistPrefs), subscribeNav(persistPrefs))

  const events = client.subscribeEvents({ include_tool_output: false }, (event) => { if (getClient() === client) onEvent(event) })
  stops.push(() => events.unsubscribe())
  stops.push(client.onNotification(USAGE_LIMITS_CHANGED_NOTIFICATION, (params) => applyLimits(params as UsageLimitsResult)))
  stops.push(onThreadActivity(activity => { if (getClient() === client) applyActivity(activity) }))
  const onOpen = () => {
    void loadProviders().catch(() => { if (getClient() === client) setNav({ providersLoaded: true }) })
    askLimits()
    void client.call('daemon.info', {}).then((info) => { if (getClient() === client) setNav({ version: info.version ?? null }) }, () => {})
  }
  stops.push(client.onStatus((status) => {
    if (status === 'open' && getClient() === client) onOpen()
  }))
  if (client.status === 'open') onOpen()
  // The rail rings stay current while the window is up (`usageLimits.ts` polls each minute).
  limitsTimer ??= setInterval(() => askLimits(), LIMITS_POLL_MS)
}

/** Keep the open child thread listed even after it settles (`visibleSubagentThreads` selectedId). */
export function ensureChild(id: ThreadId) {
  const thread = getNav().children[id]
  if (thread?.parent_thread_id) void loadChildren(thread.parent_thread_id)
}

function stopLive() {
  for (const stop of stops) stop()
  stops = []
  clearTimeout(prefsTimer); pendingPrefs?.(); pendingPrefs = undefined
  clearTimeout(activityTimer); clearInterval(limitsTimer); limitsTimer = undefined
  started = false; owner = null; lastPrefs = ''; childLoads.clear(); archived.clear()
}
onEnvironmentChange(stopLive, -100)
