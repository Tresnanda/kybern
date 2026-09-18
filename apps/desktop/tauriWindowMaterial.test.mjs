import assert from "node:assert/strict"
import test from "node:test"

const originalWindow = globalThis.window
const originalNavigator = globalThis.navigator

test.after(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow })
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: originalNavigator })
})

test("macOS Tauri material changes call the idempotent native command", async () => {
  const calls = []
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/605.1.15" },
  })
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      __TAURI_INTERNALS__: {
        transformCallback() { return 1 },
        unregisterCallback() {},
        async invoke(command, args) {
          calls.push({ command, args })
        },
      },
    },
  })

  const { setWindowVibrancy } = await import("./src/lib/tauri.ts?window-material")
  await setWindowVibrancy(false)
  await setWindowVibrancy(true)

  assert.deepEqual(calls, [
    { command: "set_window_vibrancy", args: { enabled: false } },
    { command: "set_window_vibrancy", args: { enabled: true } },
  ])
})
