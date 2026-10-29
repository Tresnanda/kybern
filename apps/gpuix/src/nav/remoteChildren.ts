// Delegated children that run on another machine, in the sidebar's and the transcript's child set (`nav.children`).
//
// A child another machine started lists on its own machine as a thread with an `origin` and no parent there
// (`isRemoteChildThread`). `machines/merged.ts` hands those over with `parent_thread_id` set to the thread that delegated
// them, so the launch card (`useChildThreads`) and the sidebar's child rows treat them like local children, with the
// child's real state: the target's events keep its list, and so this set, current.
import { isChildThread } from '../../../../packages/kybern-client/src/subagents.ts'
import type { Thread, ThreadId } from '../../../../packages/kybern-client/src/types.ts'

export interface RemoteChildSet {
  /** The ids this module put in `nav.children`, so the next call can take them out again. */
  ids: ReadonlySet<ThreadId>
  /** The next `nav.children`, or null when nothing changed. */
  children: Record<ThreadId, Thread> | null
}

/** Bring `current` in line with `remote`. A child of this machine with the same id wins; unchanged objects keep their identity. */
export function withRemoteChildren(current: Record<ThreadId, Thread>, remote: readonly (Thread & { machineId?: string })[], previous: ReadonlySet<ThreadId>): RemoteChildSet {
  const wanted = new Map<ThreadId, Thread>()
  for (const child of remote) if (isChildThread(child) && !(current[child.id] && !previous.has(child.id))) wanted.set(child.id, child)
  let next: Record<ThreadId, Thread> | null = null
  const edit = () => (next ??= { ...current })
  for (const id of previous) if (!wanted.has(id) && current[id]) delete edit()[id]
  for (const [id, child] of wanted) if (current[id] !== child) edit()[id] = child
  return { ids: new Set(wanted.keys()), children: next }
}
