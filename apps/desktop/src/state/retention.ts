import { retainedSize } from "@/lib/retainedSize"
import type { Store, AppState } from "./store"
import { collectSplitThreadIds } from "./splitView"
import { compactThreadState } from "./transcript"

export const INACTIVE_CACHE_BYTES = 16 * 1024 * 1024

/** Active panes are pinned; only reconstructible inactive data is evicted.
 * Pending approvals/questions, drafts, queues and terminal ownership survive. */
export function createRetentionPolicy(limit = INACTIVE_CACHE_BYTES) {
  const touched = new Map<string, number>()
  let clock = 0
  return (state: Store, previous: Store): Partial<AppState> | null => {
    const visible = new Set(collectSplitThreadIds(state.splitView))
    if (state.selected.kind === "thread") visible.add(state.selected.id)
    const candidates: { key: string; id: string; kind: "transcript" | "diff"; bytes: number; at: number }[] = []
    const keys = new Set<string>()
    for (const [id, transcript] of Object.entries(state.transcripts)) {
      if (!transcript.loaded && transcript.blocks.length === 0 && transcript.checkpoints.length === 0) continue
      const key = `t:${id}`
      keys.add(key)
      if (transcript !== previous.transcripts[id] || visible.has(id) || !touched.has(key)) touched.set(key, ++clock)
      if (!visible.has(id)) candidates.push({ key, id, kind: "transcript", bytes: retainedSize(transcript) + retainedSize(state.runtimeTasks[id]), at: touched.get(key)! })
    }
    for (const [id, diff] of Object.entries(state.diffs)) {
      const key = `d:${id}`
      keys.add(key)
      const threadId = id.split(":")[0]!
      if (diff !== previous.diffs[id] || visible.has(threadId) || !touched.has(key)) touched.set(key, ++clock)
      if (!visible.has(threadId)) candidates.push({ key, id, kind: "diff", bytes: retainedSize(diff), at: touched.get(key)! })
    }
    for (const key of touched.keys()) if (!keys.has(key)) touched.delete(key)
    let bytes = candidates.reduce((total, candidate) => total + candidate.bytes, 0)
    if (bytes <= limit) return null
    candidates.sort((a, b) => a.at - b.at)
    const transcripts = { ...state.transcripts }
    const diffs = { ...state.diffs }
    const runtimeTasks = { ...state.runtimeTasks }
    for (const candidate of candidates) {
      if (bytes <= limit) break
      bytes -= candidate.bytes
      touched.delete(candidate.key)
      if (candidate.kind === "diff") delete diffs[candidate.id]
      else {
        transcripts[candidate.id] = compactThreadState(transcripts[candidate.id]!)
        delete runtimeTasks[candidate.id]
      }
    }
    return { transcripts, diffs, runtimeTasks }
  }
}
