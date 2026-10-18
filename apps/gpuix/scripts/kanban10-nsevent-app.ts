// Drag input below GPUIX's mouse simulation, for kanban10-ghost-nsevent.ts: runs main.tsx with the window floating on
// screen (not activated, so its display link runs), and on SIGUSR1 replays GAP_PLAN ({ steps: [type, x, y][], gapMs })
// as real AppKit mouse events (`mouseMoved:` / `mouseDown:` / `mouseDragged:` / `mouseUp:`) delivered to `GPUIView`
// through the main run loop, like kit9-nsevent-app.ts. Window points use GPUI's top-left origin.
import { dlopen, FFIType as T, type Pointer } from 'bun:ffi'
import { readFileSync, writeFileSync } from 'node:fs'
await import('../src/main.tsx')
const L = '/usr/lib/libobjc.A.dylib'
const base = dlopen(L, { objc_getClass: { args: [T.cstring], returns: T.ptr }, sel_registerName: { args: [T.cstring], returns: T.ptr }, object_getClassName: { args: [T.ptr], returns: T.cstring } }).symbols
const c = (s: string) => Buffer.from(s + '\0')
const cls = (n: string) => base.objc_getClass(c(n))!
const sel = (n: string) => base.sel_registerName(c(n))!
const send = (args: T[], returns: T) => dlopen(L, { objc_msgSend: { args: [T.ptr, T.ptr, ...args], returns } }).symbols.objc_msgSend as unknown as (...a: unknown[]) => any
const m0 = send([], T.ptr), mI = send([], T.i64), mF = send([], T.f64), mIdx = send([T.u64], T.ptr), mSetI = send([T.i64], T.void)
const mPerf = send([T.ptr, T.ptr, T.f64], T.void)
const mEv = send([T.u64, T.f64, T.f64, T.u64, T.f64, T.i64, T.ptr, T.i64, T.i64, T.f32], T.ptr)
const app = m0(cls('NSApplication'), sel('sharedApplication')) as Pointer
const windows = () => { const arr = m0(app, sel('windows')) as Pointer; return Array.from({ length: Number(mI(arr, sel('count'))) }, (_, i) => mIdx(arr, sel('objectAtIndex:'), i) as Pointer) }
for (const w of windows()) { mSetI(w, sel('setLevel:'), 3); m0(w, sel('orderFrontRegardless')) }
const H = Number(process.env.KYBERN_WINDOW_SIZE?.split('x')[1]) || 820
const info = m0(cls('NSProcessInfo'), sel('processInfo')) as Pointer
function gpuiView(v: Pointer): Pointer | null {
  if (String(base.object_getClassName(v)).includes('GPUI')) return v
  const subs = m0(v, sel('subviews')) as Pointer
  for (let i = 0; i < Number(mI(subs, sel('count'))); i++) { const r = gpuiView(mIdx(subs, sel('objectAtIndex:'), i) as Pointer); if (r) return r }
  return null
}
const TYPES = { move: [5, 'mouseMoved:'], down: [1, 'mouseDown:'], drag: [6, 'mouseDragged:'], up: [2, 'mouseUp:'] } as const
function post(type: keyof typeof TYPES, x: number, y: number) {
  const w = windows()[0]!
  const [kind, selector] = TYPES[type]
  const click = type === 'down' || type === 'up' ? 1 : 0
  const ev = mEv(cls('NSEvent'), sel('mouseEventWithType:location:modifierFlags:timestamp:windowNumber:context:eventNumber:clickCount:pressure:'), kind, x, H - y, 0, mF(info, sel('systemUptime')), mI(w, sel('windowNumber')), null, 0, click, type === 'move' || type === 'up' ? 0 : 1)
  mPerf(gpuiView(m0(w, sel('contentView')) as Pointer)!, sel('performSelector:withObject:afterDelay:'), sel(selector), ev, 0)
}
process.on('SIGUSR1', async () => {
  const plan = JSON.parse(readFileSync(process.env.GAP_PLAN!, 'utf8')) as { steps: [keyof typeof TYPES, number, number][]; gapMs: number }
  for (const [type, x, y] of plan.steps) { post(type, x, y); await Bun.sleep(plan.gapMs) }
  writeFileSync(process.env.GAP_PLAN! + '.done', String(Date.now()))
})
export {}
