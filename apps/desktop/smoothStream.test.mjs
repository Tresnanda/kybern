import assert from "node:assert/strict"
import test from "node:test"

const { smoothAdvance, shouldCommitReveal } = await import("./src/lib/smoothStream.ts")

const start = () => ({ shown: 0, vel: 0 })

test("never overshoots the received text", () => {
  const s = smoothAdvance({ shown: 95, vel: 5 }, 100, 10_000, false)
  assert.equal(s.shown, 100)
  assert.equal(s.vel, 0)
})

test("stays put once caught up", () => {
  assert.deepEqual(smoothAdvance({ shown: 100, vel: 0 }, 100, 16, false), { shown: 100, vel: 0 })
  assert.deepEqual(smoothAdvance({ shown: 120, vel: 0 }, 100, 16, false), { shown: 100, vel: 0 })
})

test("advances every frame while text is buffered", () => {
  let s = start()
  for (let f = 0; f < 30; f++) {
    const before = s.shown
    s = smoothAdvance(s, 1000, 16, false)
    assert.ok(s.shown > before, `frame ${f} stalled at ${s.shown}`)
  }
})

// The regression that mattered: a bursty stream (chunk, gap, chunk, gap) must not
// drain the buffer inside a gap and stall — that was the "stream, stop" feel.
test("does not stall in the gaps between chunks", () => {
  let s = start()
  let target = 0
  let stalls = 0
  for (let burst = 0; burst < 12; burst++) {
    target += 55 // a chunk arrives
    for (let f = 0; f < 20; f++) {
      // ~320ms of silence before the next chunk
      const before = s.shown
      s = smoothAdvance(s, target, 16, false)
      if (s.shown < target && s.shown <= before) stalls++
    }
  }
  assert.equal(stalls, 0)
})

test("keeps a buffer instead of racing to the end mid-stream", () => {
  // Feed a steady stream; the reveal should lag behind (buffer held), not catch up.
  let s = start()
  let target = 0
  for (let f = 0; f < 60; f++) {
    target += 4 // ~240 chars/sec
    s = smoothAdvance(s, target, 16, false)
  }
  assert.ok(s.shown < target, `expected a held buffer, shown=${s.shown} target=${target}`)
  assert.ok(target - s.shown < target, "buffer should be bounded, not the whole message")
})

test("drains promptly and finishes once complete", () => {
  let s = { shown: 0, vel: 0 }
  let frames = 0
  while (s.shown < 500 && frames < 1000) {
    s = smoothAdvance(s, 500, 16, true)
    frames++
  }
  assert.equal(s.shown, 500)
  assert.ok(frames < 60, `expected a quick drain, took ${frames} frames`)
})

test("complete drains faster than live", () => {
  const framesToFinish = (complete) => {
    let s = { shown: 0, vel: 0 }
    let frames = 0
    while (s.shown < 500 && frames < 5000) {
      s = smoothAdvance(s, 500, 16, complete)
      frames++
    }
    return frames
  }
  assert.ok(framesToFinish(true) < framesToFinish(false))
})


test("reveal commits are bounded across 60 Hz and 120 Hz displays without losing the tail", () => {
  for (const hz of [60, 120]) {
    let previous = 0
    let lastAt = -Infinity
    let commits = 0
    for (let frame = 1; frame <= hz * 2; frame++) {
      const now = frame * 1000 / hz
      if (shouldCommitReveal(previous, frame, 10_000, now - lastAt)) {
        previous = frame
        lastAt = now
        commits++
      }
    }
    assert.ok(commits <= 63, `${hz} Hz produced ${commits} commits in 2 seconds`)
    assert.equal(shouldCommitReveal(previous, 10_000, 10_000, 1), true)
    assert.equal(shouldCommitReveal(10_000, 10_000, 10_000, 100), false)
  }
})
