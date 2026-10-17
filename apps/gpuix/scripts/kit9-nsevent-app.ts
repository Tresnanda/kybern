// Pointer input below GPUIX's mouse simulation: runs a GPUIX checkout's main.tsx (REVIEW_MAIN, so another checkout such
// as a base worktree can be measured), keeps the window floating on screen without activating it, and on SIGUSR1 replays
// a pointer plan (REVIEW_PLAN json: { points: [x, y][], gapMs }) as real AppKit `NSMouseMoved` events delivered to
// `GPUIView` through the main run loop (`mouseMoved:` → `handle_view_event`, the handler a hardware mouse reaches), at
// any rate and without moving the user's cursor. Window points use GPUI's top-left origin.
//
// Why not the real OS pointer: this host has no Accessibility / post-event grant (cliclick fails), and CuaDriver's
// `move_cursor` warps the cursor without posting mouse-moved events (no hover at all, in any build). Posting to NSApp's
// queue does not work either: AppKit sends untracked moves only to the key window. The window's content view is an
// AccessKit container, so the events go to the `GPUIView` under it.
import { dlopen, FFIType as T, type Pointer } from 'bun:ffi'
import { readFileSync, writeFileSync } from 'node:fs'
await import(process.env.REVIEW_MAIN!)
const L = '/usr/lib/libobjc.A.dylib'
const base = dlopen(L, { objc_getClass: { args: [T.cstring], returns: T.ptr }, sel_registerName: { args: [T.cstring], returns: T.ptr } }).symbols
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
const NSMouseMoved = 5
const cn = dlopen(L, { object_getClassName: { args: [T.ptr], returns: T.cstring } }).symbols.object_getClassName
const mSend1 = send([T.ptr], T.void)
if (process.env.REVIEW_DEBUG) writeFileSync(process.env.REVIEW_PLAN! + '.debug', windows().map((w) => `${cn(w)} #${mI(w, sel('windowNumber'))} visible=${mI(w, sel('isVisible'))} view=${cn(m0(w, sel('contentView')))}`).join('\n'))
/** GPUI's own view (`GPUIView`, maybe AccessKit-subclassed) under the window's container content view. */
function gpuiView(w: Pointer): Pointer {
  const walk = (v: Pointer, depth: string[]): Pointer | null => {
    depth.push(String(cn(v)))
    if (String(cn(v)).includes('GPUI')) return v
    const subs = m0(v, sel('subviews')) as Pointer
    for (let i = 0; i < Number(mI(subs, sel('count'))); i++) { const r = walk(mIdx(subs, sel('objectAtIndex:'), i) as Pointer, depth); if (r) return r }
    return null
  }
  const seen: string[] = []
  const found = walk(m0(w, sel('contentView')) as Pointer, seen)
  if (process.env.REVIEW_DEBUG) writeFileSync(process.env.REVIEW_PLAN! + '.views', seen.join('\n'))
  if (!found) throw new Error('no GPUI view: ' + seen.join(','))
  return found
}
function post(x: number, y: number) {
  const w = windows()[0]!
  const num = mI(w, sel('windowNumber'))
  const ev = mEv(cls('NSEvent'), sel('mouseEventWithType:location:modifierFlags:timestamp:windowNumber:context:eventNumber:clickCount:pressure:'), NSMouseMoved, x, H - y, 0, mF(info, sel('systemUptime')), num, null, 0, 0, 0)
  // GPUI's view (`handle_view_event`) receives it from the main run loop, in order, like AppKit's own dispatch.
  if (process.env.REVIEW_DIRECT) return mSend1(gpuiView(w), sel('mouseMoved:'), ev)
  mPerf(gpuiView(w), sel('performSelector:withObject:afterDelay:'), sel('mouseMoved:'), ev, 0)
}
process.on('SIGUSR1', async () => {
  const plan = JSON.parse(readFileSync(process.env.REVIEW_PLAN!, 'utf8')) as { points: [number, number][]; gapMs: number }
  for (const [x, y] of plan.points) { post(x, y); if (plan.gapMs) await Bun.sleep(plan.gapMs) }
  writeFileSync(process.env.REVIEW_PLAN! + '.done', String(Date.now()))
})
export {}
