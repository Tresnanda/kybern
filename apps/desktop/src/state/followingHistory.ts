import { retainedSize } from "@/lib/retainedSize"
import type { ThreadState } from "./transcript"

// Hysteresis avoids evicting a turn for every new message. These are retained
// data budgets, not physical-footprint guarantees or limits on a live turn.
export const FOLLOWING_HISTORY_BYTES = 16 * 1024 * 1024
export const FOLLOWING_HISTORY_BLOCKS = 1500

/** Called only at the latest output, with no reading/selection/focus to pin.
 * Keep whole turns and all unfinished work; older data remains in the daemon. */
export function trimFollowingHistory(state: ThreadState): ThreadState {
  const blocks = state.blocks
  if (!state.loaded || state.loadingEarlier) return state
  const first = new Map<string, number>()
  let pinned = blocks.length
  blocks.forEach((block, index) => {
    if (!first.has(block.turnId)) first.set(block.turnId, index)
    if ((block.kind === "assistant" || block.kind === "tool") && !block.complete ||
      block.kind === "approval" && !block.decision ||
      block.kind === "runtime_task" && ["pending", "running", "waiting", "stopping"].includes(block.task.status)) {
      pinned = Math.min(pinned, first.get(block.turnId)!)
    }
  })
  // The newest two turns and pinned work cannot be evicted. Avoid traversing
  // their potentially huge result objects when no cleanup is possible anyway.
  if (first.size <= 2 || pinned === 0 || (blocks.length <= FOLLOWING_HISTORY_BLOCKS && retainedSize(blocks) <= FOLLOWING_HISTORY_BYTES)) return state
  let start = blocks.length
  let bytes = 0
  const turns = new Set<string>()
  while (start > 0) {
    let next = first.get(blocks[start - 1]!.turnId)!
    // Interleaved background turns must not be split at the cutoff.
    for (let i = start - 1; i >= next; i--) next = Math.min(next, first.get(blocks[i]!.turnId)!)
    for (let i = next; i < start; i++) { bytes += retainedSize(blocks[i]); turns.add(blocks[i]!.turnId) }
    start = next
    if (turns.size >= 2 && (blocks.length - start >= 600 || bytes >= FOLLOWING_HISTORY_BYTES / 2)) break
  }
  start = Math.min(start, pinned)
  // Extending the suffix for pinned work can bring another interleaved turn
  // across the boundary. Close that boundary too, including equal-sequence rows.
  for (let index = blocks.length - 1; index >= start; index--) {
    start = Math.min(start, first.get(blocks[index]!.turnId)!)
    while (start > 0 && blocks[start - 1]!.seq >= blocks[start]!.seq) start = first.get(blocks[start - 1]!.turnId)!
  }
  if (!start || !blocks[start]?.seq) return state
  return { ...state, blocks: blocks.slice(start), nextBeforeSeq: blocks[start]!.seq }
}
