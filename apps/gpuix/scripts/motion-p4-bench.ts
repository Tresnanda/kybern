// Long-list open time and scroll smoothness for the P4 pages (Notes gallery, Tasks list and board), on the daemon seeded by
// `motion-p4-seed-long.ts` (306 tasks, 251 notes). Run once per build under a UI lease; compare labels.
//   VISUAL_SCRATCH=…/motion-gpuix-p4-long VISUAL_DAEMON_PORT=4374 bun native/ui-lease.ts gpuix-p4 caffeinate -d bun scripts/motion-p4-bench.ts <label> [--theme dark]
// Frame intervals come from the app's own `[kybern-frame]` log (one line per presented frame, KYBERN_FRAME_TIMES=1); no screenshots and
// no clock control run during a timed window. Open time is the wall time from the rail click to the first painted row, median of 6.
// `drops25` counts submission intervals ≥ 25 ms. It is not what the eye sees: a cheap present-only frame submitted right after a slow
// render reads as "2 ms then 30 ms" although both reach consecutive vsyncs, and a layout tween that re-renders under the pointer fills
// vsyncs that carry no new scroll position. Read `content` (frames that carried wheel input) for scrolling and BENCH_CADENCE=1
// (`displayed`, what WindowServer composited) for both; `pagesfix` in previews/motion has the comparison.
// Env: VISUAL_SCRATCH (daemon scratch), BENCH_OUT (JSON dir), BENCH_ONLY=notes|tasks, BENCH_WHEEL_HZ=60|120, BENCH_CADENCE=1.
import '../src/native/local-build.ts'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../src/requests/harness.ts'

const label = process.argv[2] ?? 'run'
const theme = process.argv.includes('--theme') ? process.argv[process.argv.indexOf('--theme') + 1]! : 'dark'
const SCRATCH = process.env.VISUAL_SCRATCH ?? '/Users/mymac/projects/ade-gpuix-scratch/motion-gpuix-p4-long'
const out = process.env.BENCH_OUT ?? '/Users/mymac/projects/ade/previews/motion/gpuix-p4'
mkdirSync(out, { recursive: true })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : 0 }
// Content frames: presented frames that carried wheel input (`[scroll-input-paint]`, KYBERN_FRAME_COSTS=1, logged before the frame's
// `[kybern-frame]`). Submission intervals alone also count frames that only re-render or re-present (a tween under the pointer),
// which hide vsyncs where no new scroll position reached the screen; the content cadence is what the eye follows.
const content: number[] = []
let scrolled = false, rest = ''
const watch = (chunk: string) => {
  const lines = (rest + chunk).split('\n'); rest = lines.pop() ?? ''
  for (const line of lines) {
    if (line.startsWith('[scroll-input-paint]')) scrolled = true
    else { const m = line.match(/^\[kybern-frame\] ([\d.]+)/); if (m) { if (scrolled) content.push(Number(m[1])); scrolled = false } }
  }
}
const f = await launchFixture(path.join(import.meta.dir, '..', 'src/main.tsx'), {
  GPUIX_BACKGROUND: '1', KYBERN_OPAQUE: '1', KYBERN_APPEARANCE: theme, KYBERN_FRAME_TIMES: '1', KYBERN_FRAME_COSTS: '1', KYBERN_WINDOW_SIZE: '1280x820',
  KYBERN_DATA_DIR: `${SCRATCH}/data`, KYBERN_CLIENT_CONFIG_DIR: `${SCRATCH}/client`, KYBERN_GPUIX_CREDENTIALS_DIR: `${SCRATCH}/credentials`, KYBERN_ENVIRONMENT_NAME: 'Development environment',
}, { stderr: watch })
const a = f.app
const result: Record<string, unknown> = { label, theme, addon: process.env.NAPI_RS_NATIVE_LIBRARY_PATH, fullRate: !!process.env.KYBERN_FULL_RATE }
const painted = async (prefix: string) => {
  try { for (const n of await a.getByType('div').all()) if (n.testId?.startsWith(prefix) && n.bounds && n.bounds.width > 0 && n.bounds.height > 0 && n.bounds.x >= 0 && n.bounds.y >= 0) return true } catch { /* tree not ready */ }
  return false
}
const click = async (id: string) => { const c = await a.getByTestId(id).center(); await a.mouse.click(c) }
const stats = (intervals: number[]) => ({ frames: intervals.length + 1, drops25: intervals.filter(x => x >= 25).length, series: intervals.map(x => +x.toFixed(1)), p50: +pct(intervals, 0.5).toFixed(1), p95: +pct(intervals, 0.95).toFixed(1), p99: +pct(intervals, 0.99).toFixed(1), over16: intervals.filter(x => x > 16.7).length, over33: intervals.filter(x => x > 33.4).length })
const intervalsSince = (from: number) => { const t = f.frameTimes().slice(from); const out: number[] = []; for (let i = 1; i < t.length; i++) out.push(t[i]! - t[i - 1]!); return out }
async function open(rail: string, first: string, after?: () => Promise<void>) {
  const times: number[] = [], frames: number[] = []
  for (let i = 0; i < 6; i++) {
    await click('rail-home'); await sleep(900)
    const mark = f.frameTimes().length
    const start = performance.now()
    await click(rail)
    while (!await painted(first)) await sleep(8)
    times.push(performance.now() - start)
    await sleep(700)
    frames.push(f.frameTimes().length - mark)
  }
  if (after) await after()
  return { openMs: +pct(times, 0.5).toFixed(0), openAll: times.map(x => +x.toFixed(0)), framesPerOpen: frames }
}
function cadenceProbe() {
  const bin = path.join(SCRATCH, 'motion-cadence')
  if (!existsSync(bin)) Bun.spawnSync(['swiftc', '-O', '-o', bin, path.join(import.meta.dir, '../perf/motion-fps/cadence.swift')])
  return bin
}
async function scroll(x: number, y: number, label: string) {
  await sleep(1200)
  const mark = f.frameTimes().length, contentMark = content.length
  // Default: the original burst (sleep 16 ms between events, ~17.5 ms apart with the RPC, so some vsyncs get no input).
  // BENCH_WHEEL_HZ=60|120: events on an absolute schedule at that rate (a trackpad's cadence), the same total distance.
  const hz = Number(process.env.BENCH_WHEEL_HZ) || 0
  // BENCH_CADENCE=1: also record what WindowServer displayed (perf/motion-fps/cadence.swift, ScreenCaptureKit at 60 Hz) over the
  // burst, cropped to the scrolled list: the intervals between changed frames. A validation mode; it costs CPU of its own.
  const cadence = process.env.BENCH_CADENCE === '1' ? Bun.spawn([cadenceProbe(), String(f.pid), '1.9', String(x - 300), String(y - 200), '600', '400'], { stdout: 'pipe' }) : null
  if (cadence) await sleep(250)
  const sends: number[] = []
  if (hz) {
    const n = Math.round(90 * hz / 60), step = 34 * 90 / n, period = 1000 / hz, t0 = performance.now()
    for (let i = 0; i < n; i++) {
      const due = t0 + i * period
      while (performance.now() < due - 2) await sleep(1)
      while (performance.now() < due) { /* spin the last ms */ }
      sends.push(performance.now()); await a.mouse.wheel({ x, y }, 0, i < n / 2 ? -step : step)
    }
  } else for (let i = 0; i < 90; i++) { sends.push(performance.now()); await a.mouse.wheel({ x, y }, 0, i < 45 ? -34 : 34); await sleep(16) }
  await sleep(500)
  const s = stats(intervalsSince(mark)); void label
  const gaps = sends.slice(1).map((t, i) => t - sends[i]!)
  const displayed = cadence ? (await cadence.exited, JSON.parse((await new Response(cadence.stdout).text()).trim().split('\n').at(-1)!)) : undefined
  const shown = content.slice(contentMark), steps = shown.slice(1).map((t, i) => t - shown[i]!)
  return { ...s, inputMs: { p50: +pct(gaps, 0.5).toFixed(1), p95: +pct(gaps, 0.95).toFixed(1), events: sends.length },
    ...(displayed ? { displayed } : {}),
    content: { frames: shown.length, p50: +pct(steps, 0.5).toFixed(1), p95: +pct(steps, 0.95).toFixed(1), stalls25: steps.filter(x => x >= 25).length, stalls40: steps.filter(x => x >= 40).length } }
}
try {
  await a.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
  await sleep(3000)
  if (process.env.BENCH_ONLY !== 'tasks') {
  result.notesOpen = await open('rail-notes', 'note-card-')
  await sleep(600)
  result.notesScroll = await scroll(700, 420, 'notes')
  // BENCH_ONLY=notes: the gallery open and scroll only (bisecting), three scroll bursts; BENCH_ONLY=tasks skips the notes
  if (process.env.BENCH_ONLY === 'notes') {
    result.notesScroll2 = await scroll(700, 420, 'notes')
    result.notesScroll3 = await scroll(700, 420, 'notes')
    console.log(JSON.stringify({ ...result, notesOpen: undefined }, (k, v) => (k === 'series' ? undefined : v)))
    writeFileSync(path.join(out, `perf-${label}-${theme}.json`), JSON.stringify(result, null, 1))
    await f.close(); process.exit(0)
  }
  }
  result.tasksListOpen = await open('rail-tasks', 'task-row-')
  await click('task-view-list').catch(() => {})
  await sleep(600)
  result.tasksListScroll = await scroll(700, 420, 'tasks list')
  // hover sweep: fast pointer travel down the rows (glyph/checkbox cross-fade, lift)
  for (const key of process.env.BENCH_ONLY === 'tasks' ? ['tasksHover', 'tasksHover2', 'tasksHover3'] : ['tasksHover']) {
    await a.mouse.move({ x: 1275, y: 815 }); await sleep(600)
    const cadence = process.env.BENCH_CADENCE === '1' ? Bun.spawn([cadenceProbe(), String(f.pid), '1.6', '300', '120', '600', '620'], { stdout: 'pipe' }) : null
    if (cadence) await sleep(250)
    const mark = f.frameTimes().length
    for (let i = 0; i < 60; i++) { await a.mouse.move({ x: 500, y: 140 + (i % 20) * 30 }); await sleep(20) }
    await sleep(400)
    const displayed = cadence ? (await cadence.exited, JSON.parse((await new Response(cadence.stdout).text()).trim().split('\n').at(-1)!)) : undefined
    result[key] = { ...stats(intervalsSince(mark)), ...(displayed ? { displayed } : {}) }
  }
  if (process.env.BENCH_ONLY === 'tasks') {
    console.log(JSON.stringify(result, (k, v) => (k === 'series' ? undefined : v)))
    writeFileSync(path.join(out, `perf-${label}-${theme}.json`), JSON.stringify(result, null, 1))
    await f.close(); process.exit(0)
  }
  await click('task-view-board'); await sleep(900)
  result.tasksBoardScroll = await scroll(520, 420, 'tasks board')
  await click('task-view-list'); await sleep(800)
  // idle: nothing may present after the page settles
  await a.mouse.move({ x: 1275, y: 815 }); await sleep(2500)
  const mark = f.frameTimes().length
  await sleep(4000)
  result.idleFramesIn4s = f.frameTimes().length - mark
  console.log(JSON.stringify(result, null, 1))
  writeFileSync(path.join(out, `perf-${label}-${theme}.json`), JSON.stringify(result, null, 1))
} finally { await f.close() }
process.exit(0)
