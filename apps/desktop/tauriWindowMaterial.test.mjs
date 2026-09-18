import assert from "node:assert/strict"
import test from "node:test"

const originalWindow = globalThis.window
const originalNavigator = globalThis.navigator

test.after(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow })
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: originalNavigator })
})

test("image IPC keeps binary bytes, Unicode names and cancellation semantics", async () => {
  const calls = []
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { __TAURI_INTERNALS__: { async invoke(command, args, options) {
      calls.push({ command, args, options })
      return false
    } } },
  })
  const { saveImageFile, writeImageClipboard } = await import("./src/lib/tauri.ts?image-actions")
  const bytes = Uint8Array.of(137, 80, 78, 71)
  assert.equal(await saveImageFile(bytes, "Pratinjau 😀.png"), false)
  await writeImageClipboard(bytes)
  assert.equal(calls[0].command, "save_image_file")
  assert.equal(calls[0].args, bytes)
  const name = calls[0].options.headers["X-Kybern-File-Name"]
  assert.match(name, /^[\x20-\x7e]*$/)
  assert.equal(JSON.parse(name), "Pratinjau 😀.png")
  assert.equal(calls[1].command, "write_image_clipboard")
  assert.equal(calls[1].args, bytes)
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} })
  assert.equal(await saveImageFile(bytes, "image.png"), null)
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
