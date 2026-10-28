import { useEffect, useSyncExternalStore } from 'react'
import { EMPTY_MESSAGE_INDEX, mergeMessages, resolveMessage, setThreadIndex, type ThreadMessageIndex } from '../../../../packages/kybern-client/src/messageStates.ts'
import { activeEnvironment, onEnvironmentChange } from '../shell/environment.ts'
import { threadClient } from '../state.ts'
import { onLiveEvent } from '../nav/live.ts'
let indexes: Record<string, ThreadMessageIndex> = {}
const loads = new Map<string, Promise<void>>()
const listeners = new Set<() => void>()
onEnvironmentChange(() => {
  indexes = {}
  loads.clear()
  for (const listener of listeners) listener()
})
function put(id: string, index: ThreadMessageIndex) {
  if (indexes[id] === index) return
  indexes = setThreadIndex(indexes, id, index)
  for (const listener of listeners) listener()
}
onLiveEvent(event => {
  if (!indexes[event.thread_id]) return
  if (event.kind === 'thread_message_held' || event.kind === 'thread_message_updated') put(event.thread_id, mergeMessages(indexes[event.thread_id], [event.message]))
  if (event.kind === 'thread_message_resolved') {
    const next = resolveMessage(indexes[event.thread_id], event.message_id, event.resolution)
    if (next) put(event.thread_id, next)
  }
})
export function useMessages(threadId: string) {
  const index = useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => indexes[threadId] ?? EMPTY_MESSAGE_INDEX)
  useEffect(() => {
    const owner = activeEnvironment()
    let client: ReturnType<typeof threadClient>
    try { client = threadClient(threadId) } catch { return } // that machine is offline
    if (!client || loads.has(threadId)) return
    // Refresh on remount/reconnect; mergeMessages preserves newer live events.
    if (!indexes[threadId]) put(threadId, EMPTY_MESSAGE_INDEX)
    const request = client.call('threads.messages.list', { thread_id: threadId }).then(result => { if (owner === activeEnvironment()) put(threadId, mergeMessages(indexes[threadId], result.messages, { fromListing: true })) }).catch(() => {}).finally(() => { if (loads.get(threadId) === request) loads.delete(threadId) })
    loads.set(threadId, request)
  }, [threadId])
  return index
}
