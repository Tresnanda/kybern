import assert from "node:assert/strict"
import test from "node:test"

import { installRuntimeErrorReporting, isResizeObserverNotice } from "./src/lib/runtimeErrors.ts"
import { observeResizeFrame } from "./src/lib/resizeObserver.ts"
import { contextUsage, limitLabel, reportedPercent, resetLabel } from "./src/lib/providerUsage.ts"

test("native resize notifications do not become interface errors; real exceptions still do", () => {
  const target = new EventTarget()
  const reported = []
  const cleanup = installRuntimeErrorReporting(target, (details) => reported.push(details))
  const notify = (message, error = null) => target.dispatchEvent(Object.assign(new Event("error", { cancelable: true }), { message, error }))
  for (const message of ["ResizeObserver loop completed with undelivered notifications.", "ResizeObserver loop limit exceeded"]) {
    assert.equal(notify(message), true, "keep native console diagnostics enabled")
    assert.equal(reported.length, 0)
    const exception = new Error(message)
    notify(message, exception)
    assert.equal(reported.pop(), exception.stack, "do not hide a thrown exception with the same text")
  }
  notify("Unable to render a message")
  assert.deepEqual(reported, ["Unable to render a message"])
  const rejection = new Error("Failed to load the view")
  target.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: rejection }))
  assert.equal(reported.at(-1), rejection.stack)
  assert.equal(isResizeObserverNotice({ message: "ResizeObserver failed to initialize", error: null }), false)
  const safariError = new Error("Cannot render preview")
  safariError.stack = "render@http://localhost/app.js:1:2"
  notify(safariError.message, safariError)
  assert.equal(reported.pop(), "Error: Cannot render preview\nrender@http://localhost/app.js:1:2")
  cleanup()
  notify("After cleanup")
  assert.equal(reported.length, 2)
})

test("resize work is deferred, coalesced to the latest measurement, and cancelled on unmount", () => {
  const original = { ResizeObserver: globalThis.ResizeObserver, requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame }
  const frames = new Map()
  let id = 0
  let observer
  globalThis.requestAnimationFrame = (callback) => { frames.set(++id, callback); return id }
  globalThis.cancelAnimationFrame = (frame) => frames.delete(frame)
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; observer = this }
    observe(element) { this.element = element }
    disconnect() { this.disconnected = true }
  }
  try {
    const element = {}
    const measurements = []
    const cleanup = observeResizeFrame(element, (entries) => measurements.push(entries[0].contentRect.height))
    assert.equal(observer.element, element)
    observer.callback([{ contentRect: { height: 120 } }])
    observer.callback([{ contentRect: { height: 160 } }])
    assert.equal(frames.size, 1)
    assert.deepEqual(measurements, [], "never write layout within observer delivery")
    const callback = frames.values().next().value
    frames.clear()
    callback()
    assert.deepEqual(measurements, [160])
    observer.callback([{ contentRect: { height: 200 } }])
    const queued = frames.values().next().value
    cleanup()
    assert.equal(observer.disconnected, true)
    assert.equal(frames.size, 0)
    queued()
    observer.callback([{ contentRect: { height: 240 } }])
    assert.equal(frames.size, 0, "ignore late observer delivery after cleanup")
    assert.deepEqual(measurements, [160], "even a late queued frame cannot update an unmounted view")
  } finally {
    Object.assign(globalThis, original)
  }
})

test("usage distinguishes unavailable context from zero usage and bounds meters", () => {
  assert.equal(contextUsage(), null)
  assert.equal(contextUsage({ used_tokens: 10, window_tokens: 0 }), null)
  assert.equal(contextUsage({ used_tokens: NaN, window_tokens: 100 }), null)
  assert.deepEqual(contextUsage({ used_tokens: 0, window_tokens: 100 }), { used: 0, window: 100, percent: 0 })
  assert.equal(contextUsage({ used_tokens: 148933, window_tokens: 258400 }).percent.toFixed(2), "57.64")
  assert.equal(reportedPercent(110), 100)
  assert.equal(reportedPercent(-10), 0)
  assert.equal(reportedPercent(Infinity), null)
  assert.equal(limitLabel({ window_minutes: 10080, name: "Primary" }), "Weekly")
  assert.equal(limitLabel({ window_minutes: 300, name: "Secondary" }), "5-hour")
  assert.equal(limitLabel({ window_minutes: null, name: "Organization" }), "Organization")
  assert.equal(resetLabel(null), "Reset time unavailable")
  assert.equal(resetLabel(Infinity), "Reset time unavailable")
  assert.equal(resetLabel(Number.MAX_VALUE), "Reset time unavailable")
})
