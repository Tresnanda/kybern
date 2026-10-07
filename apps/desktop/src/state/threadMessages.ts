// Thread message records on the client: folded from `threads.messages.list` and the
// `thread_message_*` events into `messageRecords`, so a "Sent to" row shows its message's live
// state. The pure rules (bounds, newest wins, the row's state) live in
// `packages/kybern-client/src/messageStates.ts`. No RPC here: `rpc.ts` imports this module.

import {
  mergeMessages,
  messageOf,
  replyOf,
  resolveMessage,
  setThreadIndex,
  unseedAll,
} from "../../../../packages/kybern-client/src/messageStates.ts"
import type { HeldResolution, MessageId, ThreadId, ThreadMessageRecord } from "@/protocol"
import { isThreadOpen, useStore, type AppState } from "./store"

/** Folded into the indexes of both ends of each message that already has one (and the owner's, always). */
function foldInto(state: AppState, owner: ThreadId, records: readonly ThreadMessageRecord[], fromListing: boolean): Partial<AppState> {
  let table = state.messageRecords
  const targets = new Set<ThreadId>([owner])
  for (const record of records) {
    for (const end of [record.from_thread_id, record.to_thread_id]) if (end && table[end]) targets.add(end)
  }
  for (const id of targets) {
    const own = id === owner ? records : records.filter((record) => record.from_thread_id === id || record.to_thread_id === id)
    const current = table[id]
    const next = mergeMessages(current, own, { fromListing: fromListing && id === owner })
    if (next !== current) table = setThreadIndex(table, id, next, (other) => isThreadOpen(state, other))
  }
  return table === state.messageRecords ? {} : { messageRecords: table }
}

/** A record that arrived on `owner`'s event stream. A held message also joins the recipient's held panel; a resolved one leaves it. */
export function recordThreadMessage(owner: ThreadId, record: ThreadMessageRecord) {
  useStore.getState().set((state) => {
    const patch = foldInto(state, owner, [record], false)
    const current = state.heldMessages[record.to_thread_id]
    if (record.state === "held") {
      if (current?.some((item) => item.id === record.id)) return patch
      return { ...patch, heldMessages: { ...state.heldMessages, [record.to_thread_id]: [...(current ?? []), record] } }
    }
    if (!current?.some((item) => item.id === record.id)) return patch
    const next = current.filter((item) => item.id !== record.id)
    const heldMessages = { ...state.heldMessages }
    if (next.length > 0) heldMessages[record.to_thread_id] = next
    else delete heldMessages[record.to_thread_id]
    return { ...patch, heldMessages }
  })
}

/** The reader (here or in another window) delivered or dismissed a held message. */
export function resolveThreadMessage(owner: ThreadId, messageId: MessageId, resolution: HeldResolution) {
  useStore.getState().set((state) => {
    const found = state.messageRecords[owner]?.byId[messageId]
    let table = state.messageRecords
    for (const id of new Set([owner, found?.from_thread_id ?? owner])) {
      const current = table[id]
      const next = resolveMessage(current, messageId, resolution)
      if (next && next !== current) table = { ...table, [id]: next }
    }
    return table === state.messageRecords ? {} : { messageRecords: table }
  })
}

/** What `threads.messages.list` returned for `threadId` (newest wins over any event that raced with it). */
export function seedThreadMessages(threadId: ThreadId, records: readonly ThreadMessageRecord[]) {
  useStore.getState().set((state) => foldInto(state, threadId, records, true))
}

/** Events may have been missed while disconnected, so every thread seeds again on its next Sent-to row. */
export function unseedThreadMessages() {
  useStore.getState().set((state) => {
    const messageRecords = unseedAll(state.messageRecords)
    return messageRecords === state.messageRecords ? {} : { messageRecords }
  })
}

/** One message's live record. Re-renders only when that record changes. */
export function useMessageRecord(threadId: ThreadId | null | undefined, messageId: string | null | undefined): ThreadMessageRecord | undefined {
  return useStore((state) => messageOf(threadId ? state.messageRecords[threadId] : undefined, messageId))
}

/** The reply to one message, when its record is known. Re-renders only when that record changes. */
export function useReplyRecord(threadId: ThreadId | null | undefined, messageId: string | null | undefined): ThreadMessageRecord | undefined {
  return useStore((state) => replyOf(threadId ? state.messageRecords[threadId] : undefined, messageId))
}
