// Store hooks and actions for Orchestrator V2: the Lineage tree, delegated launch rows and
// held thread messages. The pure rules live in `packages/kybern-client/src/delegations.ts`;
// this module is the React and RPC side.

import { useMemo } from "react"
import { toast } from "sonner"
import { useShallow } from "zustand/react/shallow"

import { descendantsOf, lineageCounts, lineageRows, type LineageCounts, type LineageRow } from "../../../../packages/kybern-client/src/delegations.ts"
import type { MessageId, Thread, ThreadId, ThreadMessageRecord } from "@/protocol"
import { errorText, interrupt, rpc } from "./rpc"
import { useStore, type AppState } from "./store"

const NO_MESSAGES: readonly ThreadMessageRecord[] = []

/** The thread's descendants. The signature changes only when a row would look different. */
const lineageKey = (thread: Thread) =>
  [
    thread.id, thread.title, thread.status, thread.parent_thread_id ?? "", thread.provider.kind, thread.model ?? "",
    thread.worktree?.branch ?? "", thread.created_at,
    thread.subagent?.status ?? "", thread.subagent?.backgrounded ? "b" : "", thread.subagent?.completed_at ?? "", thread.subagent?.result ?? "",
    thread.delegation?.status ?? "", thread.delegation?.completed_at ?? "", thread.delegation?.worktree_state ?? "",
    thread.delegation?.files_touched?.length ?? "", thread.delegation?.files_touched?.at(-1) ?? "", thread.delegation?.conflicts?.length ?? "", thread.delegation?.head_commit ?? "",
    thread.delegation?.result ?? "", thread.delegation?.error ?? "",
  ].join("|")

/**
 * Every descendant of one thread, from the thread table. Token and progress updates on a child
 * do not change the result, so a long Lineage does not re-render on each of them.
 */
export function createLineageThreadsSelector(rootId: ThreadId) {
  let source: AppState["threads"] | undefined
  let result: Thread[] = []
  let keys: string[] = []
  return (state: Pick<AppState, "threads">) => {
    if (state.threads === source) return result
    source = state.threads
    const found = descendantsOf(Object.values(state.threads), rootId)
    const nextKeys = found.map(lineageKey)
    if (nextKeys.length === keys.length && nextKeys.every((key, index) => key === keys[index])) return result
    keys = nextKeys
    result = found
    return result
  }
}

export function useLineageThreads(rootId: ThreadId): Thread[] {
  const select = useMemo(() => createLineageThreadsSelector(rootId), [rootId])
  return useStore(select)
}

export function useLineageRows(threads: readonly Thread[], rootId: ThreadId, expanded: Readonly<Record<string, boolean>>): LineageRow<Thread>[] {
  return useMemo(() => lineageRows(threads, rootId, { expanded }), [threads, rootId, expanded])
}

export function useLineageCounts(threads: readonly Thread[], rootId: ThreadId): LineageCounts {
  return useMemo(() => lineageCounts(threads, rootId), [threads, rootId])
}

export function useThreadTitle(id: ThreadId | null | undefined): string | undefined {
  return useStore((state) => (id ? state.threads[id]?.title : undefined))
}

// ---- actions ----

/** Stop one delegated child. Anything it delegated is stopped with it. */
export async function stopDelegatedChild(thread: Pick<Thread, "id" | "title">): Promise<boolean> {
  try {
    await interrupt(thread.id)
    return true
  } catch (error) {
    toast.error(`Unable to stop ${thread.title || "the agent"}. Try again, or open it and stop it there.`, { description: errorText(error) })
    return false
  }
}

export async function stopDelegatedChildren(threads: readonly Pick<Thread, "id" | "title">[]): Promise<void> {
  if (threads.length === 0) return
  const results = await Promise.all(threads.map((thread) => stopDelegatedChild(thread)))
  const stopped = results.filter(Boolean).length
  if (stopped > 0) toast(`Stopped ${stopped} ${stopped === 1 ? "agent" : "agents"}`)
}

/** Remove a kept worktree. `force` is what the confirmation grants; the daemon keeps the branch unless it is merged. */
export async function removeKeptWorktree(thread: Pick<Thread, "id" | "title">): Promise<boolean> {
  try {
    const updated = await rpc().call("delegations.worktree_remove", { thread_id: thread.id, force: true })
    useStore.getState().set((state) => ({ threads: { ...state.threads, [updated.id]: updated } }))
    return true
  } catch (error) {
    toast.error(`Unable to remove the worktree of ${thread.title || "this agent"}. Close anything using it, then try again.`, { description: errorText(error) })
    return false
  }
}

// ---- held messages ----

export function useHeldMessages(threadId: ThreadId): readonly ThreadMessageRecord[] {
  return useStore(useShallow((state) => state.heldMessages[threadId] ?? NO_MESSAGES))
}

function dropHeld(message: ThreadMessageRecord) {
  useStore.getState().set((state) => {
    const current = state.heldMessages[message.to_thread_id]
    if (!current) return {}
    const next = current.filter((item) => item.id !== message.id)
    const heldMessages = { ...state.heldMessages }
    if (next.length > 0) heldMessages[message.to_thread_id] = next
    else delete heldMessages[message.to_thread_id]
    return { heldMessages }
  })
}

/** Approve a held message; the daemon delivers it as the sender asked and the panel row leaves. */
export async function deliverHeldMessage(message: ThreadMessageRecord): Promise<boolean> {
  try {
    await rpc().call("threads.messages.deliver", { message_id: message.id as MessageId })
    dropHeld(message)
    return true
  } catch (error) {
    toast.error("Unable to deliver the message. Check the connection, then try again.", { description: errorText(error) })
    return false
  }
}

export async function dismissHeldMessage(message: ThreadMessageRecord): Promise<boolean> {
  try {
    await rpc().call("threads.messages.dismiss", { message_id: message.id as MessageId })
    dropHeld(message)
    return true
  } catch (error) {
    toast.error("Unable to dismiss the message. Check the connection, then try again.", { description: errorText(error) })
    return false
  }
}
