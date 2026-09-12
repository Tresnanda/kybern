import assert from "node:assert/strict"
import { createRequire } from "node:module"
import test from "node:test"

const require = createRequire(import.meta.url)
const builds = {
  esm: { event: await import("@tauri-apps/api/event"), window: await import("@tauri-apps/api/window") },
  cjs: { event: require("@tauri-apps/api/event"), window: require("@tauri-apps/api/window") },
}

// Tauri 2.11.5 replies to listen separately from evaluating the registration
// script. Keep those steps independent to reproduce fast startup cleanup.
function runtime({ rejectListen, rejectUnlisten, beforeListenReply } = {}) {
  const callbacks = new Map()
  const backend = new Map()
  const registry = Object.create(null)
  const pending = []
  let nextId = 0
  let unlistens = 0
  const emit = (event) => {
    for (const [id, listener] of backend) {
      if (listener.event === event) callbacks.get(registry[event]?.[id]?.handlerId)?.({ event, id, payload: null })
    }
  }
  const flush = () => { for (const register of pending.splice(0)) register() }
  globalThis.window = {
    __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: "main" } },
      transformCallback(handler) { const id = ++nextId; callbacks.set(id, handler); return id },
      unregisterCallback(id) { callbacks.delete(id) },
      async invoke(command, args) {
        if (command === "plugin:event|listen") {
          if (rejectListen) throw rejectListen
          const id = ++nextId
          backend.set(id, args)
          registry[args.event] ??= Object.create(null)
          pending.push(() => { registry[args.event][id] = { handlerId: args.handler } })
          beforeListenReply?.({ emit, flush, event: args.event })
          return id
        }
        if (command === "plugin:event|unlisten") {
          unlistens++
          if (rejectUnlisten) throw rejectUnlisten
          backend.delete(args.eventId)
          return
        }
        throw new Error(`Unexpected native command: ${command}`)
      },
    },
    __TAURI_EVENT_PLUGIN_INTERNALS__: {
      unregisterListener(event, eventId) {
        // The upstream script checks the event object, but not this entry.
        const listeners = registry[event]
        if (listeners) window.__TAURI_INTERNALS__.unregisterCallback(listeners[eventId].handlerId)
      },
    },
  }
  return { callbacks, backend, emit, flush, get unlistens() { return unlistens } }
}

for (const [format, api] of Object.entries(builds)) {
  test(`${format}: close-guard cleanup before registration releases both sides and survives remount`, async () => {
    const native = runtime()
    let staleCalls = 0
    const off = await api.window.getCurrentWindow().onCloseRequested((event) => {
      staleCalls++
      event.preventDefault()
    })
    await off()
    assert.equal(native.callbacks.size, 0)
    assert.equal(native.backend.size, 0)
    await off()
    assert.equal(native.unlistens, 1)
    let currentCalls = 0
    const currentOff = await api.window.getCurrentWindow().onCloseRequested((event) => {
      currentCalls++
      event.preventDefault()
    })
    native.flush()
    native.emit("tauri://close-requested")
    assert.equal(staleCalls, 0)
    assert.equal(currentCalls, 1)
    await currentOff()
    assert.equal(native.callbacks.size, 0)
    assert.equal(native.backend.size, 0)
  })

  test(`${format}: ordinary listeners deliver until cleanup`, async () => {
    const native = runtime()
    let calls = 0
    const off = await api.event.listen("remote-bootstrap", () => calls++)
    native.flush()
    native.emit("remote-bootstrap")
    assert.equal(calls, 1)
    await off()
    native.emit("remote-bootstrap")
    assert.equal(calls, 1)
    assert.equal(native.callbacks.size, 0)
    assert.equal(native.backend.size, 0)
  })

  test(`${format}: failed registration releases its callback and preserves the error`, async () => {
    const failure = new Error("listen denied")
    const native = runtime({ rejectListen: failure })
    await assert.rejects(api.event.listen("test", () => {}), (error) => error === failure)
    assert.equal(native.callbacks.size, 0)
    assert.equal(native.unlistens, 0)
  })

  test(`${format}: native cleanup errors remain observable without repeating cleanup`, async () => {
    const failure = new Error("native cleanup failed")
    const native = runtime({ rejectUnlisten: failure })
    const off = await api.event.listen("test", () => {})
    await assert.rejects(off(), (error) => error === failure)
    await assert.rejects(off(), (error) => error === failure)
    assert.equal(native.callbacks.size, 0)
    assert.equal(native.unlistens, 1)
  })

  for (const early of [false, true]) {
    test(`${format}: once cleans up when fired ${early ? "before" : "after"} the listen reply`, async () => {
      const native = runtime({ beforeListenReply: early ? ({ flush, emit, event }) => {
        flush()
        emit(event)
        emit(event)
      } : undefined })
      let calls = 0
      const off = await api.event.once("ready", () => calls++)
      native.flush()
      native.emit("ready")
      native.emit("ready")
      await off()
      assert.equal(calls, 1)
      assert.equal(native.callbacks.size, 0)
      assert.equal(native.backend.size, 0)
      assert.equal(native.unlistens, 1)
    })
  }

  test(`${format}: once can be cancelled before registration without firing`, async () => {
    const native = runtime()
    let calls = 0
    const off = await api.event.once("ready", () => calls++)
    await off()
    native.flush()
    native.emit("ready")
    assert.equal(calls, 0)
    assert.equal(native.callbacks.size, 0)
    assert.equal(native.backend.size, 0)
  })
}
