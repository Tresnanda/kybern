import assert from "node:assert/strict"
import test from "node:test"

import {
  LARGE_SOURCE_MAX_BYTES,
  diffSummaryRequest,
  mapWithConcurrency,
  shouldHighlightSource,
  virtualRange,
} from "./src/lib/workload.ts"
import { advanceSequence, mergeSequencedSnapshot } from "./src/state/bootstrap.ts"

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
