// Live state of the daemon's multi-step request cards (sign-in, permission, a question with a deadline), keyed by approval id.
// The daemon pushes `requests.progress`; `requests.progress` (the method) lists every live card on connect, and a card asks again
// when it mounts. Tiny and never persisted: an entry goes when its approval resolves. A `terminal` item has no card: its
// terminal opens as a tab of the thread, once.
import { useSyncExternalStore } from 'react'
import { REQUESTS_PROGRESS_NOTIFICATION, type RequestProgress, type ThreadEvent } from '../../../../packages/kybern-client/src/types.ts'
import { onLiveEvent } from '../nav/live.ts'
import { getPaneIds, getPaneState, localClient, threadClient } from '../state.ts'
import { openTerminalTab } from '../tabs/open.ts'

const items = new Map<string, RequestProgress>()
const listeners = new Set<() => void>()
/** Terminals already opened as tabs: a reconnect's refresh must not reopen one the reader closed. */
const openedTerminals = new Set<string>()
const emit = () => { for (const listener of listeners) listener() }

export const getRequestProgress = (approvalId: string): RequestProgress | null => items.get(approvalId) ?? null

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
export function useRequestProgress(approvalId: string): RequestProgress | null {
  return useSyncExternalStore(subscribe, () => items.get(approvalId) ?? null)
}

/** Whether `next` is older than what is kept (a slow list read racing a notification). */
export function isStale(kept: Pick<RequestProgress, 'updated_at'> | undefined, next: Pick<RequestProgress, 'updated_at'>): boolean {
  if (!kept) return false
  const a = Date.parse(kept.updated_at), b = Date.parse(next.updated_at)
  return !Number.isNaN(a) && !Number.isNaN(b) && b < a
}

export function applyProgress(next: RequestProgress, options: { openTerminal?: boolean } = {}) {
  if (next.terminal && options.openTerminal !== false && !openedTerminals.has(next.terminal.id)) {
    openedTerminals.add(next.terminal.id)
    // A sign-in's terminal is the reader's own choice (row 2); a run-in-terminal arrives unasked, so it never takes the keyboard.
    openTerminalTab(next.thread_id, { id: next.terminal.id, title: next.terminal.title || undefined }, { focus: next.kind === 'login' })
  }
  if (next.kind === 'terminal') return
  if (isStale(items.get(next.approval_id), next)) return
  items.set(next.approval_id, next)
  emit()
}

export function forgetProgress(approvalId: string) {
  if (items.delete(approvalId)) emit()
}

/** Read the live cards (all of them, or one thread's) and fold them in. */
export async function refreshProgress(threadId?: string): Promise<void> {
  let client: ReturnType<typeof localClient>
  try { client = threadId ? threadClient(threadId) : localClient() } catch { return } // the machine owning the thread is offline
  if (!client || client.status !== 'open') return
  try {
    const { items: list } = await client.call('requests.progress', threadId ? { thread_id: threadId } : {})
    for (const item of list) applyProgress(item)
  } catch { /* an older daemon has no request progress: the cards keep their asking state */ }
}

/** A button that is not an answer (`requests.act`). Throws the daemon's sentence, which the card shows under its title. */
export async function actOnRequest(approvalId: string, action: string, value?: string): Promise<void> {
  // The card's thread owns the approval: read from the live progress, else from the panes showing it.
  const threadId = items.get(approvalId)?.thread_id ?? getPaneIds().flatMap(id => getPaneState(id).open.pendingApprovals).find(a => a.id === approvalId)?.thread_id
  const client = threadClient(threadId)
  if (!client) throw new Error('Kybern is not connected. Reconnect, then try again.')
  await client.call('requests.act', { approval_id: approvalId, action, ...(value === undefined ? {} : { value }) })
}

let owner: ReturnType<typeof localClient> = null
let stops: (() => void)[] = []
/** Follow the daemon's request progress. Called by the app shell with the other live feeds (`startAgentToasts`). */
export function startRequestProgress() {
  const client = localClient() // local machine only: other machines' request progress is not followed here
  if (!client || owner === client) return
  for (const stop of stops) stop()
  owner = client
  items.clear()
  emit()
  stops = [
    client.onNotification(REQUESTS_PROGRESS_NOTIFICATION, (params) => applyProgress(params as RequestProgress)),
    client.onStatus((status) => { if (status === 'open') void refreshProgress() }),
    onLiveEvent((event: ThreadEvent) => { if (event.kind === 'approval_resolved') forgetProgress(event.approval_id) }),
  ]
  if (client.status === 'open') void refreshProgress()
}
