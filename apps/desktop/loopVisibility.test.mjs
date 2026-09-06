import assert from "node:assert/strict"
import test from "node:test"

import { observeLoopVisibility } from "./src/lib/loopVisibility.ts"

test("loop visibility shares resources, pauses without removing nodes, and cleans up on unmount", () => {
  const originalDocument = globalThis.document
  const originalObserver = globalThis.IntersectionObserver
  const listeners = new Set()
  const observers = []
  globalThis.document = {
    hidden: false,
    addEventListener(type, fn) {
      assert.equal(type, "visibilitychange")
      listeners.add(fn)
    },
    removeEventListener(type, fn) {
      assert.equal(type, "visibilitychange")
      listeners.delete(fn)
    },
  }
  globalThis.IntersectionObserver = class {
    targets = new Set()
    disconnected = false
    constructor(callback) {
      this.callback = callback
      observers.push(this)
    }
    observe(target) {
      this.targets.add(target)
    }
    unobserve(target) {
      this.targets.delete(target)
    }
    disconnect() {
      this.disconnected = true
      this.targets.clear()
    }
    report(target, isIntersecting, intersectionRatio) {
      this.callback([{ target, isIntersecting, intersectionRatio }])
    }
  }
  const element = () => ({
    paused: false,
    toggleAttribute(name, value) {
      assert.equal(name, "data-loop-paused")
      this.paused = value
    },
    removeAttribute(name) {
      assert.equal(name, "data-loop-paused")
      this.paused = false
    },
  })
  const cleanup = []
  try {
    const first = element()
    const second = element()
    const stopFirst = observeLoopVisibility(first)
    const stopSecond = observeLoopVisibility(second)
    cleanup.push(stopFirst, stopSecond)
    assert.equal(observers.length, 1)
    assert.equal(listeners.size, 1)
    assert.equal(
      first.paused,
      true,
      "wait for the first visibility observation"
    )

    const observer = observers[0]
    observer.report(first, true, 1)
    observer.report(second, true, 0)
    assert.equal(first.paused, false)
    assert.equal(second.paused, true, "touching a clip edge is not visible")
    observer.report(second, true, 0.2)
    assert.equal(second.paused, false, "partly visible loaders still animate")

    document.hidden = true
    for (const listener of listeners) listener()
    assert.equal(first.paused, true)
    assert.equal(second.paused, true)
    observer.report(second, false, 0)
    document.hidden = false
    for (const listener of listeners) listener()
    assert.equal(first.paused, false)
    assert.equal(
      second.paused,
      true,
      "showing the window must not resume offscreen loaders"
    )

    stopFirst()
    assert.equal(observer.targets.has(first), false)
    observer.report(first, false, 0)
    assert.equal(
      first.paused,
      false,
      "ignore queued entries for unmounted loaders"
    )
    assert.equal(observer.disconnected, false)
    stopSecond()
    cleanup.length = 0
    assert.equal(observer.disconnected, true)
    assert.equal(listeners.size, 0)

    // React StrictMode mounts effects again after cleanup.
    cleanup.push(observeLoopVisibility(first))
    assert.equal(observers.length, 2)
    observers[1].report(first, true, 1)
    assert.equal(first.paused, false)
  } finally {
    for (const stop of cleanup) stop()
    globalThis.document = originalDocument
    globalThis.IntersectionObserver = originalObserver
  }
})
