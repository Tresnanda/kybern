import { environmentKey } from './environment.ts'
// Agent event toasts (desktop `state/rpc.ts` `announce`): a turn that finishes or
// fails, or an agent that needs an approval or an answer, while the reader is not
// looking at that thread. Finished and failed toasts last 6 s; approval and
// question toasts stay until answered (and go when `approval_resolved` arrives, or once the reader looks at that thread:
// the card itself is then on screen and the toast would only cover its buttons).
//
// The same rules as the desktop: top-level threads only, nothing for events that
// predate this window, one announcement per event sequence, the "Finished
// working" toast once per turn, and nothing at all when the daemon's `notifications` setting is off.
// A delegated agent's question or approval is announced on its top-level thread
// ("Fix login · Parser audit needs your input"), since nobody watches the agent's own thread.
// Questions say "Needs your input", approvals "Needs approval: …".
import type { ApprovalRequest, Settings, Thread, ThreadEvent, ThreadId } from '../../../../packages/kybern-client/src/types.ts'
import { openThread } from '../nav/history.ts'
import { onLiveEvent } from '../nav/live.ts'
import { getNav, subscribeNav } from '../nav/store.ts'
import { notifications } from '../native/notifications.ts'
import { isWindowVisible } from '../native/visibility.ts'
import { getClient, getPane, getPaneIds, getState, subscribe } from '../state.ts'
import { isWindowFocused } from './window.ts'
import { toast } from './toasts.tsx'
import { startReceivedNotices } from '../machines/utilities.ts'
import { questionLine, waitingLine } from './waitingLine.ts'
import { agentName } from '../requests/model.ts'
import { createThreadNotices } from './threadNotices.ts'

const DONE_MS = 6000

/** The top-level thread a delegated agent works for, or null for a thread that is not a delegated agent. */
function rootOf(threadId: ThreadId): { root: Thread; child: Thread } | null {
  const children = getNav().children
  const child = children[threadId]
  if (!child?.delegation) return null
  let cursor: Thread | undefined = child
  for (let depth = 0; cursor && depth < 8; depth++) {
    const parent: ThreadId | null | undefined = cursor.parent_thread_id
    if (!parent) return null
    const top = getState().threads.find((t) => t.id === parent)
    if (top) return { root: top, child }
    cursor = children[parent]
  }
  return null
}

/** A thread this window knows: a top-level one, or a delegated child it follows. */
const knownThread = (id: string) => getState().threads.some((t) => t.id === id) || !!getNav().children[id]

let started = false
let owner: ReturnType<typeof getClient> = null
let stops: (() => void)[] = []
/** Follow the daemon's events. Called once by the app shell, after `startLive()`. */
export function startAgentToasts() {
  const client = getClient()
  if (!client) return
  if (started && owner === client) return
  for (const stop of stops) stop()
  stops = []
  owner = client
  started = true
  const startedAt = Date.now()
  // Files that arrive from another machine (U1): a notice with Show in folder.
  try { stops.push(startReceivedNotices()) } catch { /* the machine hub is not ready: no notices */ }
  const announced = new Map<ThreadId, number>()
  /** Waiting toasts on screen, by thread. */
  const waiting = new Map<ThreadId, Set<string>>()
  let watch: ReturnType<typeof setInterval> | null = null
  const isViewing = (threadId: ThreadId) => {
    const nav = getNav()
    return getState().selectedId === threadId && nav.page === 'home' && !nav.settingsOpen && isWindowVisible() && isWindowFocused()
  }
  const forget = (threadId: ThreadId, id: string) => {
    const ids = waiting.get(threadId)
    ids?.delete(id)
    if (ids && !ids.size) waiting.delete(threadId)
    if (!waiting.size && watch) { clearInterval(watch); watch = null }
  }
  /** What each thread's system notification announces, so an answered approval withdraws only its own. */
  const notices = createThreadNotices()
  // Window focus has no event here, so a short check runs only while a waiting toast is up.
  const clearViewed = () => {
    for (const [threadId, ids] of [...waiting]) {
      if (!isViewing(threadId)) continue
      for (const id of [...ids]) { toast.dismiss(id); forget(threadId, id) }
      // The card is on screen now; the system notification that asked for it has done its job.
      if (notices.viewed(threadId)) void notifications.dismiss(threadId)
    }
  }
  stops.push(subscribeNav(() => { if (waiting.size) clearViewed() }))
  stops.push(subscribe(() => { if (waiting.size) clearViewed() }))
  stops.push(() => { if (watch) clearInterval(watch); watch = null; waiting.clear() })
  const finished = new Map<ThreadId, string>()
  const targets = new Map<string, { environment: string; thread: string }>()
  stops.push(notifications.onClick(id => {
    // A click on a post older than the remembered ones reports its group, which is the thread (`group` below).
    const target = targets.get(id) ?? (knownThread(id) ? { environment: environmentKey(), thread: id } : undefined)
    // The native delegate activates the app/window. Never open a thread on a
    // different daemon after an environment switch.
    if (target?.environment === environmentKey()) openThread(target.thread)
  }))
  let enabled = true

  const readSettings = (settings: Settings | undefined) => {
    if (settings) enabled = settings.notifications !== false
  }
  const load = () => void client.call('settings.get', {}).then(readSettings, () => {})
  stops.push(client.onNotification('settings.changed', (params) => readSettings((params as { settings?: Settings } | null)?.settings)))
  stops.push(client.onStatus((status) => {
    if (status === 'open') load()
  }))
  if (client.status === 'open') load()

  stops.push(onLiveEvent((event: ThreadEvent) => {
    if (getClient() !== client) return
    if (event.kind === 'approval_resolved') {
      const id = `agent-input:${event.approval_id}`
      forget(event.thread_id, id)
      // Answered anywhere, so the notification that asked is stale too.
      if (notices.resolved(event.thread_id, event.approval_id)) void notifications.dismiss(event.thread_id)
      return toast.dismiss(id)
    }
    const kind =
      event.kind === 'turn_failed'
        ? 'failed'
        : event.kind === 'approval_requested' || event.kind === 'user_input_requested'
          ? 'blocked'
          : event.kind === 'turn_completed' && event.stop_reason === 'completed'
            ? 'done'
            : null
    if (!kind || !enabled) return
    const own = getState().threads.find((t) => t.id === event.thread_id)
    // Child and subagent threads are not in the list: the desktop's `threadCanNotify`. A delegated agent's request is the exception.
    const delegated = !own && kind === 'blocked' ? rootOf(event.thread_id) : null
    const thread = own ?? delegated?.root
    if (!thread) return
    // A delegated agent speaks under its own name ("Parser audit is waiting for your answer").
    const delegatedName = delegated ? delegated.child.title || 'An agent' : undefined
    // Replayed history updates the transcript without replaying old alerts.
    if (Date.parse(event.at) < startedAt || event.seq <= (announced.get(event.thread_id) ?? 0)) return
    announced.set(event.thread_id, event.seq)
    const nav = getNav()
    // On screen in any pane, not just the focused one: its own transcript already shows the result.
    const onScreen = (id: ThreadId) => getState().selectedId === id || getPaneIds().some((paneId) => getPane(paneId)?.selectedId === id)
    const viewing = (onScreen(event.thread_id) || (!!delegated && onScreen(thread.id))) && nav.page === 'home' && !nav.settingsOpen
    if (viewing && isWindowVisible() && isWindowFocused()) return
    if (kind === 'done') {
      if (event.turn_id && finished.get(event.thread_id) === event.turn_id) return
      if (event.turn_id) finished.set(event.thread_id, event.turn_id)
    }
    const title = thread.title || 'Thread'
    const named = agentName(thread.provider.kind)
    const agent = delegatedName ?? named.charAt(0).toUpperCase() + named.slice(1)
    if (!isWindowFocused()) {
      const id = `agent:${event.thread_id}:${event.seq}`
      targets.set(id, { environment: environmentKey(), thread: event.thread_id })
      if (targets.size > 256) targets.delete(targets.keys().next().value!)
      const body = event.kind === 'turn_failed' ? `Failed: ${event.error}`
        : event.kind === 'approval_requested' ? waitingLine(event.approval, agent)
        : event.kind === 'user_input_requested' ? questionLine(event.approval, agent) : 'Finished working'
      void notifications.requestPermission().then(status => {
        if (status === 'granted' && getClient() === client && enabled && !isWindowFocused()) {
          const approval = event.kind === 'approval_requested' || event.kind === 'user_input_requested' ? event.approval.id : null
          return notifications.post({ id, title, body, group: event.thread_id }).then(posted => {
            if (posted) notices.posted(event.thread_id, approval)
            if (process.env.KYBERN_DEBUG_NOTIFICATIONS) console.error('[notifications] posted', posted, id, title, body)
          })
        }
        if (process.env.KYBERN_DEBUG_NOTIFICATIONS) console.error('[notifications] not posted', status)
      }).catch(error => console.error('[notifications]', error))
    }
    // Visible but not focused: the system notification above says it, and a toast would only sit on the page being read.
    if (viewing && isWindowVisible()) return
    const open = { label: 'Open thread', onClick: () => openThread(event.thread_id) }
    if (event.kind === 'user_input_requested' || event.kind === 'approval_requested') {
      const id = `agent-input:${event.approval.id}`
      waiting.set(event.thread_id, (waiting.get(event.thread_id) ?? new Set()).add(id))
      watch ??= setInterval(clearViewed, 1000)
      toast(title, {
        id,
        description: event.kind === 'user_input_requested' ? questionLine(event.approval, agent) : waitingLine(event.approval, agent),
        duration: Infinity,
        action: open,
      })
    } else {
      toast(title, {
        id: `agent:${event.thread_id}:${event.seq}`,
        description: event.kind === 'turn_failed' ? `Failed: ${event.error}` : 'Finished working',
        duration: DONE_MS,
        action: open,
      })
    }
  }))
}

