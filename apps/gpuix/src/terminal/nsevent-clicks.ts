// Entry for verify-clicks.ts: the app (main.tsx) plus real AppKit mouse-down/up events with a click count, which
// GPUIX's automation cannot send. On SIGUSR1 it replays CLICK_PLAN ({ clicks: { x, y, count }[] }, window points,
// top-left origin) to `GPUIView`'s `mouseDown:`/`mouseUp:` through the main run loop, like kit9-nsevent-app.ts does
// for moves. The user's cursor never moves and the window is never activated.
import { dlopen, FFIType as T, type Pointer } from 'bun:ffi'
import { readFileSync, writeFileSync } from 'node:fs'
await import('../main.tsx')
const L = '/usr/lib/libobjc.A.dylib'
const base = dlopen(L, { objc_getClass: { args: [T.cstring], returns: T.ptr }, sel_registerName: { args: [T.cstring], returns: T.ptr }, object_getClassName: { args: [T.ptr], returns: T.cstring } }).symbols
const c = (s: string) => Buffer.from(s + '\0')
const cls = (n: string) => base.objc_getClass(c(n))!
const sel = (n: string) => base.sel_registerName(c(n))!
const send = (args: T[], returns: T) => dlopen(L, { objc_msgSend: { args: [T.ptr, T.ptr, ...args], returns } }).symbols.objc_msgSend as unknown as (...a: unknown[]) => any
const m0 = send([], T.ptr), mI = send([], T.i64), mF = send([], T.f64), mIdx = send([T.u64], T.ptr)
const mPerf = send([T.ptr, T.ptr, T.f64], T.void)
const mEv = send([T.u64, T.f64, T.f64, T.u64, T.f64, T.i64, T.ptr, T.i64, T.i64, T.f32], T.ptr)
const app = m0(cls('NSApplication'), sel('sharedApplication')) as Pointer
const info = m0(cls('NSProcessInfo'), sel('processInfo')) as Pointer
const H = Number(process.env.KYBERN_WINDOW_SIZE?.split('x')[1]) || 820
const window = () => { const arr = m0(app, sel('windows')) as Pointer; return mIdx(arr, sel('objectAtIndex:'), 0) as Pointer }
function gpuiView(v: Pointer): Pointer | null {
  if (String(base.object_getClassName(v)).includes('GPUI')) return v
  const subs = m0(v, sel('subviews')) as Pointer
  for (let i = 0; i < Number(mI(subs, sel('count'))); i++) { const r = gpuiView(mIdx(subs, sel('objectAtIndex:'), i) as Pointer); if (r) return r }
  return null
}
const LEFT_DOWN = 1, LEFT_UP = 2
function post(type: number, x: number, y: number, count: number, delay: number) {
  const w = window(), view = gpuiView(m0(w, sel('contentView')) as Pointer)!
  const ev = mEv(cls('NSEvent'), sel('mouseEventWithType:location:modifierFlags:timestamp:windowNumber:context:eventNumber:clickCount:pressure:'), type, x, H - y, 0, mF(info, sel('systemUptime')), mI(w, sel('windowNumber')), null, 0, count, type === LEFT_DOWN ? 1 : 0)
  mPerf(view, sel('performSelector:withObject:afterDelay:'), sel(type === LEFT_DOWN ? 'mouseDown:' : 'mouseUp:'), ev, delay)
}
process.on('SIGUSR1', () => {
  const plan = JSON.parse(readFileSync(process.env.CLICK_PLAN!, 'utf8')) as { clicks: { x: number; y: number; count: number }[] }
  // AppKit numbers the presses of one multi-click 1, 2, 3 within the double-click interval.
  plan.clicks.forEach((click, i) => { post(LEFT_DOWN, click.x, click.y, click.count, i * 0.08); post(LEFT_UP, click.x, click.y, click.count, i * 0.08 + 0.03) })
  setTimeout(() => writeFileSync(process.env.CLICK_PLAN! + '.done', String(Date.now())), plan.clicks.length * 80 + 200)
})
export {}
