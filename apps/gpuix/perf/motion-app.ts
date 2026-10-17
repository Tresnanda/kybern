// Full application entry with opt-in measurement. No fixture rendering replaces
// the application. Background launch remains nonactivating; keep it unoccluded.
import type { Pointer } from 'bun:ffi'
const hook = {
  supportsFiber: true, renderers: new Map(),
  inject(renderer: unknown) { this.renderers.set(1, renderer); return 1 },
  onCommitFiberRoot() { console.error(`[motion-commit] ${performance.now().toFixed(3)}`) },
  onCommitFiberUnmount() {}, onScheduleFiberRoot() {},
}
;(globalThis as Record<string, unknown>).__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook
await import('../src/main.tsx')
const { each, getObjc, nsApp, sel } = await import('../src/native/objc.ts')
const o = getObjc(), app = nsApp()
if (app) each(o, o.msg(app, sel(o, 'windows')) as Pointer, window => {
  // Synthetic renderer input still works; unrelated physical pointer movement
  // must not cancel a measured carry or trigger AppKit window dragging.
  o.msgSetBool(window, sel(o, 'setIgnoresMouseEvents:'), true)
  o.msgSetI64(window, sel(o, 'setLevel:'), 3n)
  o.msg(window, sel(o, 'orderFrontRegardless'))
})
