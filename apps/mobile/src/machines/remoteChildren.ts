// Children that live on another machine than their parent (ADE-107, mobile side of GPUIX `nav/remoteChildren.ts`).
//
// - A delegated child another machine started lists on its own machine as a thread with an `origin` and no
//   parent there (`isRemoteChildThread`). The merged lists give it a `parentKey` naming the thread that started it.
//   Here it is shown under that parent, with its real state, and it keeps its own machine, so it opens there.
// - The subagents and delegated children of a thread on another machine are read from that machine
//   (`threads.list { parent_thread_id }`), which is `ChildThreads.tsx`'s job; this file only merges the two.
import { scopedKey } from "../../../../packages/kybern-client/src/machineMerge";
import { isRemoteChildThread } from "../../../../packages/kybern-client/src/subagents";
import type { MachineId, Thread } from "../../../../packages/kybern-client/src/types";

/** What the merged lists hold per thread (`MergedThread`). */
export interface ListedThread {
  machineId: MachineId;
  thread: Thread;
  parentKey?: string;
}

const nested = new WeakMap<Thread, { parentId: string; result: Thread }>();

/** The child as the parent's list shows it: `parent_thread_id` is the thread that started it. Unchanged sources keep their identity. */
function underParent(child: Thread, parentId: string): Thread {
  if (child.parent_thread_id === parentId) return child;
  const old = nested.get(child);
  if (old?.parentId === parentId) return old.result;
  const result: Thread = { ...child, parent_thread_id: parentId };
  nested.set(child, { parentId, result });
  return result;
}

/**
 * The delegated children other machines (or this one) started from the thread `parentId` of `parentMachineId`:
 * listed threads that carry an `origin` naming it and have no parent where they run.
 */
export function remoteChildrenOf(listed: readonly ListedThread[], parentMachineId: MachineId, parentId: string): Thread[] {
  const parentKey = scopedKey(parentMachineId, parentId);
  const out: Thread[] = [];
  for (const entry of listed) {
    if (entry.parentKey !== parentKey || entry.thread.status === "archived" || !isRemoteChildThread(entry.thread)) continue;
    out.push(underParent(entry.thread, parentId));
  }
  return out;
}

/**
 * The parent's own children (read from its machine) and the remote ones, once each. A copy with the newer
 * `last_seq` wins when both lists carry the same thread.
 */
export function mergeChildren(own: readonly Thread[], remote: readonly Thread[]): Thread[] {
  if (!remote.length) return own as Thread[];
  const byId = new Map<string, Thread>();
  for (const thread of [...own, ...remote]) {
    const current = byId.get(thread.id);
    if (!current || thread.last_seq > current.last_seq) byId.set(thread.id, thread);
  }
  return [...byId.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
}
