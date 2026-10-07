import assert from "node:assert/strict"
import test from "node:test"

import { createElapsedClock } from "./src/lib/elapsedClock.ts"

function setup(startNow = 10_000) {
  const state = { now: startNow, running: true, timers: [] }
  const clock = createElapsedClock({
    now: () => state.now,
    setTimer: (run, ms) => {
      const timer = { run, at: state.now + ms }
      state.timers.push(timer)
      return timer
    },
    clearTimer: (timer) => {
      state.timers = state.timers.filter((candidate) => candidate !== timer)
    },
    running: () => state.running,
  })
  const advance = (ms) => {
    const until = state.now + ms
    for (;;) {
      const next = state.timers.filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at)[0]
      if (!next) break
      state.timers = state.timers.filter((timer) => timer !== next)
      state.now = next.at
      next.run()
    }
    state.now = until
  }
  return { state, clock, advance }
}
const node = () => ({ textContent: "", paused: false, hasAttribute(name) { return name === "data-loop-paused" && this.paused } })

test("a tracked node shows the elapsed time at once and updates on second boundaries", () => {
  const { clock, advance } = setup(10_000)
  const el = node()
  clock.track(el, 0)
  assert.equal(el.textContent, "10s")
  advance(1010)
  assert.equal(el.textContent, "11s")
  advance(50_000)
  assert.equal(el.textContent, "1m 01s")
})

test("it writes only when the text changed", () => {
  const { clock, advance } = setup(10_000)
  let writes = 0
  let text = ""
  const el = { get textContent() { return text }, set textContent(value) { writes += 1; text = value } }
  clock.track(el, 0)
  assert.equal(writes, 1)
  advance(3010)
  assert.equal(writes, 4)
})

test("the timer stops when the last node unregisters and does not run with an empty registry", () => {
  const { state, clock } = setup()
  assert.equal(state.timers.length, 0)
  const stop = clock.track(node(), 0)
  assert.equal(state.timers.length, 1)
  stop()
  assert.equal(state.timers.length, 0)
  assert.equal(clock.size, 0)
})

test("a hidden window pauses the clock and resuming writes once immediately", () => {
  const { state, clock, advance } = setup(10_000)
  const el = node()
  clock.track(el, 0)
  state.running = false
  advance(5000)
  assert.equal(el.textContent, "10s", "the tick that was already scheduled saw a hidden window and wrote nothing")
  assert.equal(state.timers.length, 0, "and nothing is rescheduled")
  state.running = true
  clock.wake()
  assert.equal(el.textContent, "15s")
  assert.equal(state.timers.length, 1)
})

test("offscreen nodes are skipped on a tick and catch up on the next one", () => {
  const { clock, advance } = setup(10_000)
  const el = node()
  clock.track(el, 0)
  el.paused = true
  advance(2000)
  assert.equal(el.textContent, "10s")
  el.paused = false
  advance(1010)
  assert.equal(el.textContent, "13s")
})

test("a settled duration is written once and never ticks", () => {
  const { state, clock } = setup()
  const el = node()
  clock.settle(el, 0, 221_000)
  assert.equal(el.textContent, "3m 41s")
  assert.equal(state.timers.length, 0)
  assert.equal(clock.size, 0)
})
