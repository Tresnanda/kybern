// Composer sends that wait in the outbox for a machine that is away (design §6.1, §6.4). The outbox lives on the machine the user
// is at and tells its clients when an item changes (`outbox.changed`); this module turns that into what the composer shows:
// a new chat that "Waits for satyamas" and then opens, or fails with Retry; a follow-up to a thread on an away machine.
// Nothing here runs with one machine.
import type { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
import { optimisticThread, titleFromMessage } from '../../../../packages/kybern-client/src/newChat.ts'
import { isComposerOutbox, outboxThreadId, queuedPhase } from '../../../../packages/kybern-client/src/pendingSends.ts'
import { queuedCreate } from '../../../../packages/kybern-client/src/machineTarget.ts'
import { FREE_CHAT_PROJECT_ID, type MachineId, type OutboxItem, type ThreadId, type ThreadsCreateParams, type ThreadsSendParams } from '../../../../packages/kybern-client/src/types.ts'
import { machineHub } from '../machines/index.ts'
import { getState, localClient } from '../state.ts'
import { newChats } from './newChats.ts'
import { addPending, updatePending } from './pending.ts'

/** A machine's name as the composer says it ("Waiting for satyamas"). */
export const machineName = (machineId: MachineId | undefined): string => (machineId && machineHub().set.connection(machineId) ? machineHub().set.displayName(machineId) : undefined) ?? 'that machine'

/** Follow-ups waiting in the outbox, by outbox item. */
const sends = new Map<string, { threadId: ThreadId; sendId: string; machineId: MachineId }>()

/** Queue a follow-up to a thread on a machine that is away. It shows as waiting and goes when the machine returns. */
export async function queueSend(machineId: MachineId, params: ThreadsSendParams & { message_id: string }): Promise<void> {
  const client = localClient()
  if (!client) throw new Error('Reconnect and try again.')
  const item = await client.call('outbox.enqueue', { target: machineId, operation: { kind: 'thread_send', payload: params } })
  sends.set(item.id, { threadId: params.thread_id, sendId: params.message_id, machineId })
  updatePending(params.thread_id, params.message_id, { state: 'waiting', machineId })
}

function applyItem(item: OutboxItem) {
  if (!isComposerOutbox(item)) return
  const chat = newChats.outbox(item)
  if (chat) {
    // The first message's bubble follows the chat: waiting, delivered (its own event replaces the bubble), or failed.
    if (chat.state === 'created') updatePending(chat.threadId, chat.messageId, { state: 'accepted' })
    else if (chat.state === 'failed') updatePending(chat.threadId, chat.messageId, { state: 'failed', ...(chat.error ? { error: chat.error } : {}) })
    else if (chat.state === 'waiting') updatePending(chat.threadId, chat.messageId, { state: 'waiting', ...(chat.machineId ? { machineId: chat.machineId } : {}) })
  }
  const follow = sends.get(item.id)
  if (!follow) return
  const phase = queuedPhase(item, machineName(follow.machineId))
  if (phase.phase === 'delivered') { sends.delete(item.id); updatePending(follow.threadId, follow.sendId, { state: 'accepted' }) }
  else if (phase.phase === 'failed') { sends.delete(item.id); updatePending(follow.threadId, follow.sendId, { state: 'failed', error: phase.error }) }
}

/** Chats still waiting from before this window started: shown again, with their first message. */
function restoreChat(item: OutboxItem) {
  const params = item.payload as ThreadsCreateParams | null
  const threadId = outboxThreadId(item)
  if (item.kind !== 'thread_create' || !params?.message || !params.message_id || !threadId || newChats.get(threadId) || getState().threads.some((t) => t.id === threadId)) return
  const logical = params.project_id
    ? machineHub().view().projects.find((p) => p.instances.some((i) => i.machineId === item.target && i.project.id === params.project_id))
    : undefined
  const local = machineHub().localMachineId
  const listed = logical ? logical.instances.find((i) => i.machineId === local)?.project.id ?? logical.primary.project.id : FREE_CHAT_PROJECT_ID
  const messageId = params.message_id
  const thread = {
    ...optimisticThread({ id: threadId, projectId: listed, provider: params.provider, model: params.model ?? null, effort: params.effort ?? null, permissionMode: params.permission_mode ?? 'supervised', message: params.message, now: new Date(item.created_at) }),
    title: params.title ?? titleFromMessage(params.message),
    machineId: item.target,
    offline: true,
    ...(params.project_id ? { ownProjectId: params.project_id } : {}),
  }
  const retry = async () => {
    const queued = await need().call('outbox.enqueue', { target: item.target, operation: queuedCreate({ ...params, thread_id: threadId }) })
    return { queued: { outboxId: queued.id } }
  }
  addPending({ id: messageId, threadId, message: params.message, at: item.created_at, delivery: 'send', state: 'waiting', machineId: item.target })
  newChats.restore({ threadId, messageId, message: params.message, worktree: !!params.use_worktree, thread, machineId: item.target, machineName: machineName(item.target), outboxId: item.id }, retry)
}
const need = () => { const client = localClient(); if (!client) throw new Error('Reconnect and try again.'); return client }

/** Follow the machine you are at's outbox: live changes, and what is waiting now. Called once per connection. */
export function watchOutbox(client: KybernClient, current: () => boolean) {
  client.onNotification('outbox.changed', (params) => { if (current() && params) applyItem(params as OutboxItem) })
  const read = () => client.call('outbox.list', {}).then(({ items }) => {
    if (!current()) return
    for (const item of items) { if (item.state === 'queued' || item.state === 'sending') restoreChat(item); applyItem(item) }
  }).catch(() => {})
  void read()
  // A machine that returns is when waiting items move; read again so a missed notification cannot leave one stuck.
  return machineHub().onMachinesChanged(() => { if (current() && (newChats.unlisted().length || sends.size)) void read() })
}
