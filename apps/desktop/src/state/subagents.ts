// Store hooks and actions for provider-native subagent threads. The pure rules live in
// `packages/kybern-client/src/subagents.ts`; this module is the React and RPC side.

import { useMemo, useSyncExternalStore } from "react"
import { findModel } from "../../../../packages/kybern-client/src/models"
import { formatEffort } from "@/lib/format"
import { toast } from "sonner"
import { useShallow } from "zustand/react/shallow"

import { isChildThread, stoppableSubagents, subagentAncestors, subagentChildren, subagentDepth } from "../../../../packages/kybern-client/src/subagents.ts"
import type { Thread, ThreadId } from "@/protocol"
import { backgroundSubagent, errorText, loadThread, stopSubagent } from "./rpc"
import { useStore, type AppState } from "./store"

/** A subagent's direct children, rebuilt only when the thread table changes. */
export function createSubagentChildrenSelector(parentId: ThreadId) {
  let source: AppState["threads"] | undefined
  let result: Thread[] = []
  return (state: Pick<AppState, "threads">) => {
    if (state.threads === source) return result
    source = state.threads
    const next = subagentChildren(Object.values(state.threads), parentId)
    if (next.length !== result.length || next.some((thread, index) => thread !== result[index])) result = next
    return result
  }
}

const sidebarKey = (thread: Thread) =>
  `${thread.id}|${thread.title}|${thread.status}|${thread.parent_thread_id ?? ""}|${thread.provider.kind}|${thread.subagent?.status}|${thread.subagent?.started_at}|${thread.subagent?.completed_at ?? ""}|${thread.delegation?.status ?? ""}|${thread.delegation?.started_at ?? ""}|${thread.delegation?.completed_at ?? ""}`

/**
 * Child threads of one project for the sidebar: provider subagents and Kybern-delegated children.
 * Progress, tokens, tool names and touched files change every few seconds; the list only changes
 * when a row would look different.
 */
export function createSidebarSubagentsSelector(projectId: string) {
  let source: AppState["threads"] | undefined
  let result: Thread[] = []
  let keys: string[] = []
  return (state: Pick<AppState, "threads">) => {
    if (state.threads === source) return result
    source = state.threads
    const next = Object.values(state.threads).filter((thread) => isChildThread(thread) && thread.project_id === projectId && thread.status !== "archived")
    const nextKeys = next.map(sidebarKey)
    if (nextKeys.length === keys.length && nextKeys.every((key, index) => key === keys[index])) return result
    keys = nextKeys
    result = next
    return result
  }
}

/** The thread's direct subagent threads, oldest launch first. */
export function useSubagentChildren(parentId: ThreadId): Thread[] {
  const select = useMemo(() => createSubagentChildrenSelector(parentId), [parentId])
  return useStore(useShallow(select))
}

/** Show a subagent (or its parent) as an ordinary thread view; a history step like any other. */
export function openThreadView(id: ThreadId) {
  useStore.getState().selectThread(id)
  void loadThread(id)
}

export function openParentOf(thread: Pick<Thread, "parent_thread_id">): boolean {
  if (!thread.parent_thread_id) return false
  openThreadView(thread.parent_thread_id)
  return true
}

/** Stop one subagent, telling the reader what to do when it cannot be stopped. */
export async function stopOneSubagent(thread: Pick<Thread, "id" | "title">): Promise<boolean> {
  try {
    await stopSubagent(thread.id)
    return true
  } catch (error) {
    toast.error(`Unable to stop ${thread.title || "the subagent"}. Try again, or stop the parent turn.`, { description: errorText(error) })
    return false
  }
}

/** Stop every working subagent in `threads`, without a confirmation: the parent carries on and is told. */
export async function stopAllSubagents(threads: readonly Thread[]): Promise<void> {
  const targets = stoppableSubagents(threads)
  if (targets.length === 0) return
  const results = await Promise.all(targets.map((thread) => stopOneSubagent(thread)))
  const stopped = results.filter(Boolean).length
  if (stopped > 0) toast(`Stopped ${stopped} ${stopped === 1 ? "subagent" : "subagents"}`)
}

export async function runSubagentInBackground(thread: Pick<Thread, "id" | "title">): Promise<void> {
  try {
    await backgroundSubagent(thread.id)
  } catch (error) {
    toast.error(`Unable to move ${thread.title || "the subagent"} to the background. Try again.`, { description: errorText(error) })
  }
}

// ---- sidebar rows the reader has dismissed (or that finished and left) ----

const dismissed = new Set<ThreadId>()
let dismissedSnapshot: ReadonlySet<ThreadId> = dismissed
const listeners = new Set<() => void>()

export function dismissSubagentRow(id: ThreadId) {
  if (dismissed.has(id)) return
  dismissed.add(id)
  dismissedSnapshot = new Set(dismissed)
  for (const listener of listeners) listener()
}

export function useDismissedSubagentRows(): ReadonlySet<ThreadId> {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => dismissedSnapshot,
    () => dismissedSnapshot,
  )
}

// ---- selectors the thread view uses, so child progress does not re-render it ----

/** Legacy helper threads (real Kybern threads started from this one), not provider subagents or delegated children. */
export function createHelperThreadsSelector(parentId: ThreadId) {
  let source: AppState["threads"] | undefined
  let result: Thread[] = []
  return (state: Pick<AppState, "threads">) => {
    if (state.threads === source) return result
    source = state.threads
    const next = Object.values(state.threads).filter((thread) => thread.parent_thread_id === parentId && thread.status !== "archived" && !isChildThread(thread))
    if (next.length !== result.length || next.some((thread, index) => thread !== result[index])) result = next
    return result
  }
}

/** The chain above a thread, topmost first. Empty for a thread with no known parent. */
export function createAncestorsSelector(threadId: ThreadId) {
  let source: AppState["threads"] | undefined
  let result: Thread[] = []
  return (state: Pick<AppState, "threads">) => {
    if (state.threads === source) return result
    source = state.threads
    const thread = state.threads[threadId]
    const next = thread ? subagentAncestors(thread, (id) => state.threads[id]) : []
    if (next.length !== result.length || next.some((item, index) => item !== result[index])) result = next
    return result
  }
}

export function useHelperThreads(parentId: ThreadId): Thread[] {
  const select = useMemo(() => createHelperThreadsSelector(parentId), [parentId])
  return useStore(useShallow(select))
}

export function useAncestors(threadId: ThreadId): Thread[] {
  const select = useMemo(() => createAncestorsSelector(threadId), [threadId])
  return useStore(useShallow(select))
}

/** 0 for an ordinary thread, 1 for a subagent, 2 for a subagent of a subagent. */
export function useSubagentDepth(threadId: ThreadId): number {
  return useStore((state) => {
    const thread = state.threads[threadId]
    return thread?.subagent ? subagentDepth(thread, (id) => state.threads[id]) : 0
  })
}

/** The thread table without subagent or delegated threads, kept as the same object while only they change. */
export function createUserThreadsSelector() {
  let source: AppState["threads"] | undefined
  let result: AppState["threads"] = {}
  return (state: Pick<AppState, "threads">) => {
    if (state.threads === source) return result
    source = state.threads
    const next: AppState["threads"] = {}
    let same = true
    let count = 0
    for (const [id, thread] of Object.entries(state.threads)) {
      if (isChildThread(thread)) continue
      next[id as ThreadId] = thread
      count += 1
      if (result[id as ThreadId] !== thread) same = false
    }
    if (same && count === Object.keys(result).length) return result
    result = next
    return result
  }
}

/** Wall-clock time for derivations that only need to be right when their inputs change. */
export const nowMs = () => Date.now()

/** "Opus 4.5" for a catalogued model id, the id itself otherwise, and null when the harness never said. */
export function useSubagentModel(thread: Pick<Thread, "model" | "effort" | "provider">): { model: string | null; effort: string | null } {
  const providers = useStore((state) => state.providers)
  return useMemo(() => {
    const models = providers.find((provider) => provider.kind === thread.provider.kind)?.models ?? []
    const known = thread.model ? findModel(models, thread.model) : undefined
    return { model: known?.display_name ?? thread.model ?? null, effort: thread.effort ? formatEffort(thread.effort) : null }
  }, [providers, thread.model, thread.effort, thread.provider.kind])
}

/** ⌘↑ on a subagent page. */
export function openParentShortcut(threadId: ThreadId): boolean {
  const thread = useStore.getState().threads[threadId]
  return thread ? openParentOf(thread) : false
}
