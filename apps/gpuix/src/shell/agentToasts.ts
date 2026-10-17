import { environmentKey, onEnvironmentChange } from './environment.ts'
// Agent event toasts (desktop `state/rpc.ts` `announce`): a turn that finishes or
// fails, or an agent that needs an approval or an answer, while the reader is not
// looking at that thread. Finished and failed toasts last 6 s; approval and
// question toasts stay until answered (and go when `approval_resolved` arrives).
//
// The same rules as the desktop: top-level threads only, nothing for events that
// predate this window, one announcement per event sequence, the "Finished
// working" toast once per turn, and nothing at all when the daemon's `notifications` setting is off.
import type { Settings, ThreadEvent, ThreadId } from '../../../../packages/kybern-client/src/types.ts'
import { openThread } from '../nav/history.ts'
import { onLiveEvent } from '../nav/live.ts'
import { getNav } from '../nav/store.ts'
import { notifications } from '../native/notifications.ts'
import { isWindowVisible } from '../native/visibility.ts'
import { getClient, getState } from '../state.ts'
import { isWindowFocused } from './window.ts'
import { toast } from './toasts.tsx'

const DONE_MS = 6000

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
  const announced = new Map<ThreadId, number>()
  const finished = new Map<ThreadId, string>()
  const targets = new Map<string, { environment: string; thread: string }>()
  stops.push(notifications.onClick(id => {
    const target = targets.get(id)
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
    if (event.kind === 'approval_resolved') return toast.dismiss(`agent-input:${event.approval_id}`)
    const kind =
      event.kind === 'turn_failed'
        ? 'failed'
        : event.kind === 'approval_requested' || event.kind === 'user_input_requested'
          ? 'blocked'
          : event.kind === 'turn_completed' && event.stop_reason === 'completed'
            ? 'done'
            : null
    if (!kind || !enabled) return
    const thread = getState().threads.find((t) => t.id === event.thread_id)
    // Child and subagent threads are not in the list: the desktop's `threadCanNotify`.
    if (!thread) return
    // Replayed history updates the transcript without replaying old alerts.
    if (Date.parse(event.at) < startedAt || event.seq <= (announced.get(event.thread_id) ?? 0)) return
    announced.set(event.thread_id, event.seq)
    const nav = getNav()
    const viewing = getState().selectedId === event.thread_id && nav.page === 'home' && !nav.settingsOpen
    if (viewing && isWindowVisible() && isWindowFocused()) return
    if (kind === 'done') {
      if (event.turn_id && finished.get(event.thread_id) === event.turn_id) return
      if (event.turn_id) finished.set(event.thread_id, event.turn_id)
    }
    const title = thread.title || 'Thread'
    if (!isWindowFocused()) {
      const id = `agent:${event.thread_id}:${event.seq}`
      targets.set(id, { environment: environmentKey(), thread: event.thread_id })
      if (targets.size > 256) targets.delete(targets.keys().next().value!)
      const body = event.kind === 'turn_failed' ? `Failed: ${event.error}`
        : event.kind === 'approval_requested' ? `Needs approval: ${event.approval.summary}`
        : event.kind === 'user_input_requested' ? 'Needs your input' : 'Finished working'
      void notifications.requestPermission().then(status => {
        if (status === 'granted' && getClient() === client && enabled && !isWindowFocused()) {
          return notifications.post({ id, title, body }).then(posted => { if (process.env.KYBERN_DEBUG_NOTIFICATIONS) console.error('[notifications] posted', posted, id, title, body) })
        }
        if (process.env.KYBERN_DEBUG_NOTIFICATIONS) console.error('[notifications] not posted', status)
      }).catch(error => console.error('[notifications]', error))
    }
    const open = { label: 'Open thread', onClick: () => openThread(event.thread_id) }
    if (event.kind === 'user_input_requested' || event.kind === 'approval_requested') {
      toast(title, {
        id: `agent-input:${event.approval.id}`,
        description: event.kind === 'user_input_requested' ? 'Needs your input' : `Needs approval: ${event.approval.summary}`,
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

onEnvironmentChange(() => { for (const stop of stops) stop(); stops = []; started = false }, -100)
