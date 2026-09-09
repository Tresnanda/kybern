// Fixture-only transport, replaced at build time for Notes and QueuedPanel.
import { useStore } from "../src/state/store"
import type { QueuedMessage, ThreadNotes } from "../src/protocol"
export * from "../src/state/rpc"
export const transport = { fail: false, sent: [] as { method: string; params: unknown }[] }
export const rpc = () => ({ async call(method: string, params: unknown) {
  transport.sent.push({ method, params })
  await new Promise(resolve => setTimeout(resolve, 40))
  if (transport.fail) throw new Error("Save failed. Try again.")
  if (method === "threads.notes.set") {
    const p = params as { thread_id: string; text: string; expected_revision: number }
    const state = useStore.getState().transcripts[p.thread_id]!
    if (p.expected_revision !== (state.notes?.revision ?? 0)) throw new Error("Notes changed on another device.")
    const notes: ThreadNotes = { text: p.text, revision: p.expected_revision + 1 }
    useStore.getState().updateTranscript(p.thread_id, value => ({ ...value, notes }))
    return notes
  }
  if (method === "queue.update") {
    const item = params as QueuedMessage
    useStore.getState().set(state => ({ queued: { ...state.queued, [item.thread_id]: state.queued[item.thread_id]!.map(q => q.id === item.id ? item : q) } }))
    return {}
  }
  throw new Error(`Unexpected fixture RPC: ${method}`)
} })
export const activeRuntime = () => ({ rpc })
export async function removeQueuedMessage(threadId: string, id: string) {
  useStore.getState().set(state => ({ queued: { ...state.queued, [threadId]: state.queued[threadId]!.filter(q => q.id !== id) } }))
}
