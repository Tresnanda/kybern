import assert from "node:assert/strict"
import test from "node:test"

import {
  LARGE_SOURCE_MAX_BYTES,
  canHighlightCode,
  diffSummaryRequest,
  mapWithConcurrency,
  shouldHighlightSource,
  virtualRange,
} from "./src/lib/workload.ts"
import { advanceSequence, mergeSequencedSnapshot } from "./src/state/bootstrap.ts"
import { advanceIconSwap, settleIconSwap } from "./src/lib/iconSwap.ts"
import { reconcileVirtualTopology } from "./src/lib/virtualTopology.ts"

test("thread and history diff summaries never transfer eager patches", () => {
  assert.deepEqual(diffSummaryRequest("thread-1"), { thread_id: "thread-1", include_patch: false })
  assert.deepEqual(diffSummaryRequest("thread-1", "turn-80"), { thread_id: "thread-1", turn_id: "turn-80", include_patch: false })
})

test("expensive project work is concurrency bounded and order preserving", async () => {
  let active = 0
  let peak = 0
  const results = await mapWithConcurrency(
    [40, 5, 30, 10, 20, 1],
    3,
    async (delay, index) => {
      active++
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, delay))
      active--
      return index
    }
  )

  assert.equal(peak, 3)
  assert.deepEqual(results, [0, 1, 2, 3, 4, 5])
})

test("large source files bypass syntax highlighting", () => {
  assert.equal(shouldHighlightSource("const answer = 42\n"), true)
  assert.equal(
    shouldHighlightSource("x".repeat(LARGE_SOURCE_MAX_BYTES + 1)),
    false
  )
  assert.equal(shouldHighlightSource("x\n".repeat(4_001)), false)
})

test("code fallback releases the highlighted subtree at language and source limits", () => {
  const short = "const answer = 42\n"
  assert.equal(canHighlightCode("typescript", short), true)
  assert.equal(canHighlightCode("mermaid", short), false)
  assert.equal(canHighlightCode(null, short), false)
  assert.equal(canHighlightCode("typescript", "x".repeat(LARGE_SOURCE_MAX_BYTES + 1)), false)
  assert.equal(canHighlightCode("typescript", "x\n".repeat(4_001)), false)
})

test("icon swaps retain only the transitioning pair and survive rapid reversal", () => {
  const initial = { shown: "a", leaving: null }
  const forward = advanceIconSwap(initial, "b")
  assert.deepEqual(forward, { shown: "b", leaving: "a" })
  const reversed = advanceIconSwap(forward, "a")
  assert.deepEqual(reversed, { shown: "a", leaving: "b" })
  assert.equal(settleIconSwap(reversed, "b"), reversed, "a stale exit timer cannot remove the reversed pair")
  assert.deepEqual(settleIconSwap(reversed, "a"), { shown: "a", leaving: null })
})

test("the Explorer window renders only nearby fixed-height rows", () => {
  assert.deepEqual(virtualRange(10_000, 28_000, 560), {
    start: 992,
    end: 1_028,
    before: 27_776,
    after: 251_216,
  })
})

test("workspace hydration cannot roll a live thread back to an older snapshot", () => {
  const live = { id: "thread-1", last_seq: 12, title: "Live" }
  const stale = { id: "thread-1", last_seq: 9, title: "Stale" }
  const fresh = { id: "thread-2", last_seq: 4, title: "Fresh" }

  assert.deepEqual(mergeSequencedSnapshot({ "thread-1": live }, [stale, fresh]), {
    "thread-1": live,
    "thread-2": fresh,
  })
})

test("workspace hydration retains records created after snapshot collection began", () => {
  const createdLive = { id: "thread-new", last_seq: 21, title: "New" }
  assert.deepEqual(mergeSequencedSnapshot({ "thread-new": createdLive }, []), {
    "thread-new": createdLive,
  })
})

test("live folds advance stale sequence numbers carried inside event projections", () => {
  const staleProjection = { id: "thread-1", last_seq: 11, title: "Running" }
  assert.deepEqual(advanceSequence(staleProjection, 12), {
    id: "thread-1",
    last_seq: 12,
    title: "Running",
  })
  assert.equal(advanceSequence(staleProjection, 10), staleProjection)
})

test("workspace hydration respects the transcript cursor without publishing token-only thread changes", () => {
  const live = { id: "thread-1", last_seq: 12, title: "Live" }
  const stale = { id: "thread-1", last_seq: 19, title: "Stale" }
  const cursors = { "thread-1": { lastSeq: 20 } }
  assert.equal(mergeSequencedSnapshot({ "thread-1": live }, [stale], cursors)["thread-1"], live)
  const fresh = { ...stale, last_seq: 21, title: "Fresh" }
  assert.equal(mergeSequencedSnapshot({ "thread-1": live }, [fresh], cursors)["thread-1"], fresh)
})

test("virtual topology stays stable across content-only replacements", () => {
  const key = item => item.id
  const estimate = item => item.estimate
  const first = reconcileVirtualTopology(null, [
    { id: "a", estimate: 40, text: "old" },
    { id: "b", estimate: 60, text: "settled" },
  ], key, estimate)
  const streamed = reconcileVirtualTopology(first, [
    { id: "a", estimate: 40, text: "new streamed content" },
    { id: "b", estimate: 60, text: "settled" },
  ], key, estimate)
  assert.equal(streamed, first)
})

test("virtual topology changes for keys, order, count, or estimates", () => {
  const key = item => item.id
  const estimate = item => item.estimate
  const first = reconcileVirtualTopology(null, [
    { id: "a", estimate: 40 },
    { id: "b", estimate: 60 },
  ], key, estimate)
  const changedEstimate = reconcileVirtualTopology(first, [
    { id: "a", estimate: 41 },
    { id: "b", estimate: 60 },
  ], key, estimate)
  assert.notEqual(changedEstimate, first)
  assert.deepEqual(changedEstimate, { keys: ["a", "b"], estimates: [41, 60] })

  const reordered = reconcileVirtualTopology(first, [
    { id: "b", estimate: 60 },
    { id: "a", estimate: 40 },
  ], key, estimate)
  assert.notEqual(reordered, first)
  assert.deepEqual(reordered.keys, ["b", "a"])

  const appended = reconcileVirtualTopology(first, [
    { id: "a", estimate: 40 },
    { id: "b", estimate: 60 },
    { id: "c", estimate: 80 },
  ], key, estimate)
  assert.notEqual(appended, first)
  assert.deepEqual(appended.keys, ["a", "b", "c"])
})
