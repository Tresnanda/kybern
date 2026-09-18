import { retainedSize } from "@/lib/retainedSize"
import type { Store, AppState } from "./store"
import { collectSplitThreadIds } from "./splitView"
import { compactThreadState } from "./transcript"

export const INACTIVE_CACHE_BYTES = 16 * 1024 * 1024
/** Per visible thread. Reconstructible via `loadDiff`; mounted turns reload. */
export const VISIBLE_TURN_DIFFS = 16

function visibleTurnDiffLimit() {
  return import.meta.env?.VITE_LIVE_TOOLS_UNBOUND_TURN_DIFFS === "1"
    ? Number.POSITIVE_INFINITY
    : VISIBLE_TURN_DIFFS
}

function threadIdFromDiffKey(id: string) {
  const sep = id.indexOf(":")
  return sep < 0 ? id : id.slice(0, sep)
}

function isWholeThreadDiffKey(id: string) {
  return id.endsWith(":all")
}

/** Drop the oldest per-turn diffs on visible threads. Whole-thread (`:all`) cards stay. */
export function boundVisibleTurnDiffs<T>(
  diffs: Record<string, T>,
  visible: ReadonlySet<string>,
  touched: Map<string, number>,
  limit: number,
): Record<string, T> | null {
  if (!Number.isFinite(limit) || limit < 0) return null
  const byThread = new Map<string, string[]>()
  for (const id of Object.keys(diffs)) {
    const threadId = threadIdFromDiffKey(id)
    if (!visible.has(threadId) || isWholeThreadDiffKey(id)) continue
    const ids = byThread.get(threadId)
    if (ids) ids.push(id)
    else byThread.set(threadId, [id])
  }
  const extra: string[] = []
  for (const ids of byThread.values()) {
    if (ids.length <= limit) continue
    ids.sort((a, b) => (touched.get(`d:${a}`) ?? 0) - (touched.get(`d:${b}`) ?? 0))
    extra.push(...ids.slice(0, ids.length - limit))
  }
  if (extra.length === 0) return null
  const next = { ...diffs }
  for (const id of extra) {
    delete next[id]
    touched.delete(`d:${id}`)
  }
  return next
}

/** Active panes are pinned; only reconstructible inactive data is evicted.
 * Pending approvals/questions, drafts, queues and terminal ownership survive.
 * Visible threads still bound per-turn diffs; the changes-panel summary stays. */
export function createRetentionPolicy(
  limit = INACTIVE_CACHE_BYTES,
  turnDiffLimit = visibleTurnDiffLimit(),
) {
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
      const threadId = threadIdFromDiffKey(id)
      // Visible diffs must not all look equally fresh each pass or LRU collapses
      // to object order and remounted turns cannot keep their summaries.
      if (diff !== previous.diffs[id] || !touched.has(key)) touched.set(key, ++clock)
      if (!visible.has(threadId)) candidates.push({ key, id, kind: "diff", bytes: retainedSize(diff), at: touched.get(key)! })
    }
    for (const key of touched.keys()) if (!keys.has(key)) touched.delete(key)
    let bytes = candidates.reduce((total, candidate) => total + candidate.bytes, 0)
    let diffs = state.diffs
    let transcripts: Store["transcripts"] | undefined
    let runtimeTasks: Store["runtimeTasks"] | undefined
    if (bytes > limit) {
      transcripts = { ...state.transcripts }
      diffs = { ...state.diffs }
      runtimeTasks = { ...state.runtimeTasks }
      candidates.sort((a, b) => a.at - b.at)
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
    }
    const bounded = boundVisibleTurnDiffs(diffs, visible, touched, turnDiffLimit)
    if (bounded) diffs = bounded
    if (diffs === state.diffs && !transcripts) return null
    return {
      ...(transcripts ? { transcripts, runtimeTasks } : {}),
      ...(diffs !== state.diffs ? { diffs } : {}),
    }
  }
}
