import '../src/native/local-build.ts'
import { render, useGpuixRequired } from '@gpuix/react'
import { useEffect, useState } from 'react'
import { dlopen, FFIType, type Pointer } from 'bun:ffi'
import { cls, cstr, each, getObjc, nsApp, sel } from '../src/native/objc.ts'

// A window that redraws 20 times a second and reports the frame watchdog
// (`getFrameWatchdog`, gpui_macos window.rs) once a second on stderr as
// `[frame-stall-lab] {...}`. `frame-stall-check.ts` reconfigures displays
// under it and reads those lines. `KYBERN_LAB_HOP_DISPLAYS=<id>,<id>` with
// `KYBERN_LAB_HOP_MS` moves the window between those displays on a timer.
// `KYBERN_LAB_IDLE=1` leaves the window idle (no redraws) for idle CPU;
// `KYBERN_LAB_SLOW_MS` changes its color once per period (dropped-frame check).
type Watchdog = { getFrameWatchdog?: () => Record<string, unknown> | null }

const hopDisplays = (process.env.KYBERN_LAB_HOP_DISPLAYS ?? '').split(',').map(Number).filter(Boolean)
const hopMs = Number(process.env.KYBERN_LAB_HOP_MS ?? 0)

function hop(step: number) {
  const o = getObjc()
  const app = nsApp()
  if (!app) return
  let window: Pointer | null = null
  each(o, o.msg(app, sel(o, 'windows')) as Pointer, w => { window ??= w })
  if (!window) return
  const target = hopDisplays[step % hopDisplays.length]
  each(o, o.msg(cls(o, 'NSScreen')!, sel(o, 'screens')) as Pointer, screen => {
    const info = o.msg(screen, sel(o, 'deviceDescription')) as Pointer
    const key = o.msgPtrArg(cls(o, 'NSString')!, sel(o, 'stringWithUTF8String:'), cstr('NSScreenNumber')) as Pointer
    const number = o.msgPtrArg(info, sel(o, 'objectForKey:'), key) as Pointer | null
    if (!number || Number(o.msgU64(number, sel(o, 'unsignedIntValue'))) !== target) return
    const frameKey = o.msgPtrArg(cls(o, 'NSString')!, sel(o, 'stringWithUTF8String:'), cstr('frame')) as Pointer
    const boxed = o.msgPtrArg(screen, sel(o, 'valueForKey:'), frameKey) as Pointer
    const text = String(o.msgCStr(o.msg(boxed, sel(o, 'description')) as Pointer, sel(o, 'UTF8String')) ?? '')
    const [x, y] = text.match(/-?\d+(?:\.\d+)?/g)!.map(Number)
    const { symbols } = dlopen('/usr/lib/libobjc.A.dylib', { objc_msgSend: { args: [FFIType.ptr, FFIType.ptr, FFIType.f64, FFIType.f64], returns: FFIType.void } })
    symbols.objc_msgSend(window!, sel(o, 'setFrameOrigin:'), x! + 100 + (step % 3) * 20, y! + 100)
    if (process.env.KYBERN_LAB_HOP_DEBUG) process.stderr.write(`[frame-stall-lab] hop ${step} to ${target} ${text}\n`)
  })
}

function Lab() {
  const renderer = useGpuixRequired() as unknown as Watchdog
  const [tick, setTick] = useState(0)
  useEffect(() => {
    // `KYBERN_LAB_IDLE=1`: no redraws and no sampling, for idle CPU.
    const idle = process.env.KYBERN_LAB_IDLE === '1'
    // `KYBERN_LAB_SLOW_MS=<ms>`: one change per <ms> (red/green by parity),
    // logged as `[frame-stall-lab] tick <n>`, idle in between.
    const slowMs = Number(process.env.KYBERN_LAB_SLOW_MS ?? 0)
    const redraw = idle ? undefined : setInterval(() => setTick(n => {
      if (slowMs) process.stderr.write(`[frame-stall-lab] tick ${n + 1}\n`)
      return n + 1
    }), slowMs || 50)
    // Frame gaps measured here, apart from the watchdog: the served-frame
    // counter sampled every 20 ms; a gap over 200 ms counts as a stall.
    // The sampler's own lateness shows a blocked main thread (JS runs on it):
    // `labMaxLateMs` is the longest delay past its 20 ms period, `labBlocks` the
    // delays over 200 ms.
    let lastFrames = -1, lastChange = performance.now(), maxGap = 0, gaps = 0, stalledMs = 0, inGap = false
    let lastSample = performance.now(), maxLate = 0, blocks = 0
    const sample = idle ? undefined : setInterval(() => {
      const frames = Number(renderer.getFrameWatchdog?.()?.frames ?? 0), now = performance.now()
      const late = now - lastSample - 20
      lastSample = now
      maxLate = Math.max(maxLate, late)
      if (late > 200) blocks++
      if (frames !== lastFrames) {
        const gap = now - lastChange
        if (gap > 200) stalledMs += gap
        lastFrames = frames; lastChange = now; inGap = false
        return
      }
      const gap = now - lastChange
      maxGap = Math.max(maxGap, gap)
      if (gap > 200 && !inGap) { inGap = true; gaps++ }
    }, 20)
    const report = setInterval(() => {
      const open = performance.now() - lastChange
      process.stderr.write(`[frame-stall-lab] ${JSON.stringify({ ...renderer.getFrameWatchdog?.(), labGaps: gaps, labMaxGapMs: Math.round(maxGap), labStalledMs: Math.round(stalledMs + (open > 200 ? open : 0)), labMaxLateMs: Math.round(maxLate), labBlocks: blocks })}\n`)
      maxGap = 0; maxLate = 0
    }, 1000)
    let step = 0
    const hopper = hopDisplays.length && hopMs ? setInterval(() => hop(++step), hopMs) : undefined
    return () => { clearInterval(redraw); clearInterval(sample); clearInterval(report); clearInterval(hopper) }
  }, [renderer])
  const slow = Number(process.env.KYBERN_LAB_SLOW_MS ?? 0) > 0
  return <div testId="app-ready" style={{ width: '100%', height: '100%', backgroundColor: slow ? (tick % 2 ? '#30a040' : '#c03030') : '#202020', color: '#e0e0e0', display: 'flex', flexDirection: 'column', gap: 8, padding: 16 }}>
    <text style={{ fontSize: 28 }}>{`Tick ${tick}`}</text>
    <div style={{ width: 40 + (tick % 200) * 2, height: 12, backgroundColor: '#4a7fd0' }} />
  </div>
}

render(<Lab />, { title: 'Frame stall check', width: 600, height: 400, focus: false })
