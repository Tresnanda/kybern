// The app, kept on screen at floating level without activating it, so macOS neither occludes it behind the
// user's windows nor parks its display link and the visibility-aware loops keep running (like `idle-app.ts`
// with KYBERN_IDLE_VISIBLE=1). Use for timing and resource runs; the window is ours, nothing else is touched.
import type { Pointer } from 'bun:ffi'
await import('../src/main.tsx')
const { each, getObjc, nsApp, sel } = await import('../src/native/objc.ts')
const o = getObjc(), app = nsApp()
if (app) each(o, o.msg(app, sel(o, 'windows')) as Pointer, (window) => {
  o.msgSetI64(window, sel(o, 'setLevel:'), 3n)
  o.msg(window, sel(o, 'orderFrontRegardless'))
})
export {}

// Test hooks for the hidden-window checks: SIGUSR1 minimizes the window, SIGUSR2 brings it back (real AppKit state).
const windows = (fn: (window: Pointer) => void) => { if (app) each(o, o.msg(app, sel(o, 'windows')) as Pointer, fn) }
process.on('SIGUSR1', () => windows((window) => o.msgSetPtr(window, sel(o, 'miniaturize:'), null as unknown as Pointer)))
process.on('SIGUSR2', () => windows((window) => { o.msgSetPtr(window, sel(o, 'deminiaturize:'), null as unknown as Pointer); o.msg(window, sel(o, 'orderFrontRegardless')) }))
