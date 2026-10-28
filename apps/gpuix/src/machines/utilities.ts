// The machine utilities in the app (M4 / U1 Files): "Send to…" from the Files dock with a toast that follows the send, and the
// notice for files that arrive from another machine. Wording and rules are in `machineUtilities.ts` (shared with mobile).
import type { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
import { receivedNotice, sendFinished, sendStatus, sendToastShape, type SendTarget, type TerminalMachine } from '../../../../packages/kybern-client/src/machineUtilities.ts'
import { FILES_PROGRESS_NOTIFICATION, FILES_RECEIVED_NOTIFICATION, OUTBOX_CHANGED_NOTIFICATION, type FilesProgress, type FilesReceived, type OutboxItem } from '../../../../packages/kybern-client/src/types.ts'
import { errorText } from '../nav/actions.ts'
import { revealQuietly } from '../platform/os.ts'
import { toast } from '../shell/toasts.tsx'
import { getState, ownProjectId } from '../state.ts'
import { openTab } from '../tabs/open.ts'
import { clientFor, machineHub } from './index.ts'

const base = (path: string) => path.replace(/\/+$/, '').split('/').pop() || path

/** Send a file or folder (`path`, relative to the project root) to another machine, with a toast that follows it to the end. */
export async function sendPath(client: KybernClient, projectId: string, path: string, target: SendTarget): Promise<void> {
  const name = base(path) || 'project'
  try {
    const sent = await client.call('files.send', { project_id: projectId, path, machine: target.machineId })
    const id = `send:${sent.item.id}`
    let progress: FilesProgress | null = null
    let stops: (() => void)[] = []
    const show = (item: OutboxItem) => {
      const status = sendStatus(item, target.name, progress)
      const shape = sendToastShape(status)
      toast[shape.kind](name, { id, description: status.text, duration: shape.duration, ...(shape.progress === undefined ? {} : { progress: shape.progress }) })
      if (sendFinished(status)) { for (const stop of stops) stop(); stops = [] }
    }
    let latest = sent.item
    stops = [
      client.onNotification(OUTBOX_CHANGED_NOTIFICATION, (params) => { const item = params as OutboxItem; if (item.id === sent.item.id) { latest = item; show(item) } }),
      client.onNotification(FILES_PROGRESS_NOTIFICATION, (params) => { const next = params as FilesProgress; if (next.item_id === sent.item.id) { progress = next; show({ ...latest, state: 'sending' }) } }),
    ]
    show(latest)
  } catch (error) {
    toast.error(`Could not send ${name}`, { description: errorText(error) })
  }
}

/** Follow `files.received` on every machine the app talks to. Returns the stop. */
export function startReceivedNotices(): () => void {
  const hub = machineHub()
  const subs = new Map<string, () => void>()
  const seen = new Set<string>()
  const sync = () => {
    const ids = new Set(hub.connections().map((connection) => connection.record.machineId))
    for (const [id, stop] of subs) if (!ids.has(id)) { stop(); subs.delete(id) }
    for (const id of ids) {
      if (subs.has(id)) continue
      subs.set(id, hub.set.handleFor(id).onNotification(FILES_RECEIVED_NOTIFICATION, (params) => {
        const received = params as FilesReceived
        if (seen.has(received.transfer_id)) return
        seen.add(received.transfer_id)
        const notice = receivedNotice(received)
        // The folder is on that machine's disk: it can only be shown when the machine is the one the app runs on.
        const here = hub.localMachineId === id
        toast.success(notice.title, { description: notice.description, duration: 10000, ...(here ? { action: { label: 'Show in folder', onClick: () => revealQuietly(notice.path) } } : {}) })
      }))
    }
  }
  sync()
  const off = hub.onMachinesChanged(sync)
  return () => { off(); for (const stop of subs.values()) stop(); subs.clear() }
}

/** The folder a terminal on `machineId` starts in: that machine's checkout of the thread's repository, when it has one. */
function checkoutOn(threadId: string, machineId: string): string | undefined {
  const thread = getState().threads.find((item) => item.id === threadId)
  if (!thread) return undefined
  const own = ownProjectId(thread)
  const logical = machineHub().view().projects.find((project) => project.instances.some((instance) => instance.project.id === own && (!thread.machineId || instance.machineId === thread.machineId)))
  return logical?.instances.find((instance) => instance.machineId === machineId)?.project.path
}

/** Open a terminal on another machine as a tab of the thread (U4). It is created on that machine's own daemon. */
export async function openTerminalOn(threadId: string, machine: TerminalMachine, leaf?: string): Promise<void> {
  const cwd = checkoutOn(threadId, machine.machineId)
  const info = await clientFor(machine.machineId).call('terminals.create', { cols: 100, rows: 24, ...(cwd ? { cwd } : {}) })
  openTab(threadId, { kind: 'terminal', id: info.id, machineId: machine.machineId }, leaf ? { leaf } : undefined)
}
