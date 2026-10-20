// The gallery window kept on screen at floating level without activation (timing and resource runs): see kit9-app.ts.
import type { Pointer } from 'bun:ffi'
await import('./kit9-gallery-entry.tsx')
const { each, getObjc, nsApp, sel } = await import('../src/native/objc.ts')
const o = getObjc(), app = nsApp()
if (app) each(o, o.msg(app, sel(o, 'windows')) as Pointer, (window) => {
  o.msgSetI64(window, sel(o, 'setLevel:'), 3n)
  o.msg(window, sel(o, 'orderFrontRegardless'))
})
export {}
