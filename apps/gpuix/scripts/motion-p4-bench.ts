// Long-list open time and scroll smoothness for the P4 pages (Notes gallery, Tasks list and board), on the daemon seeded by
// `motion-p4-seed-long.ts` (306 tasks, 251 notes). Run once per build under a UI lease; compare labels.
//   VISUAL_SCRATCH=…/motion-gpuix-p4-long VISUAL_DAEMON_PORT=4374 bun native/ui-lease.ts gpuix-p4 caffeinate -d bun scripts/motion-p4-bench.ts <label> [--theme dark]
// Frame intervals come from the app's own `[kybern-frame]` log (one line per presented frame, KYBERN_FRAME_TIMES=1); no screenshots and
// no clock control run during a timed window. Open time is the wall time from the rail click to the first painted row, median of 6.
import '../src/native/local-build.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../src/requests/harness.ts'

const label = process.argv[2] ?? 'run'
const theme = process.argv.includes('--theme') ? process.argv[process.argv.indexOf('--theme') + 1]! : 'dark'
const SCRATCH = '/Users/mymac/projects/ade-gpuix-scratch/motion-gpuix-p4-long'
const out = '/Users/mymac/projects/ade/previews/motion/gpuix-p4'
mkdirSync(out, { recursive: true })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : 0 }
const f = await launchFixture(path.join(import.meta.dir, '..', 'src/main.tsx'), {
  GPUIX_BACKGROUND: '1', KYBERN_OPAQUE: '1', KYBERN_APPEARANCE: theme, KYBERN_FRAME_TIMES: '1', KYBERN_WINDOW_SIZE: '1280x820',
  KYBERN_DATA_DIR: `${SCRATCH}/data`, KYBERN_CLIENT_CONFIG_DIR: `${SCRATCH}/client`, KYBERN_GPUIX_CREDENTIALS_DIR: `${SCRATCH}/credentials`, KYBERN_ENVIRONMENT_NAME: 'Development environment',
})
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
async function scroll(x: number, y: number, label: string) {
  await sleep(1200)
  const mark = f.frameTimes().length
  for (let i = 0; i < 90; i++) { await a.mouse.wheel({ x, y }, 0, i < 45 ? -34 : 34); await sleep(16) }
  await sleep(500)
  const s = stats(intervalsSince(mark)); void label
  return s
}
try {
  await a.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
  await sleep(3000)
  result.notesOpen = await open('rail-notes', 'note-card-')
  await sleep(600)
  result.notesScroll = await scroll(700, 420, 'notes')
  result.tasksListOpen = await open('rail-tasks', 'task-row-')
  await click('task-view-list').catch(() => {})
  await sleep(600)
  result.tasksListScroll = await scroll(700, 420, 'tasks list')
  // hover sweep: fast pointer travel down the rows (glyph/checkbox cross-fade, lift)
  {
    const mark = f.frameTimes().length
    for (let i = 0; i < 60; i++) { await a.mouse.move({ x: 500, y: 140 + (i % 20) * 30 }); await sleep(20) }
    await sleep(400)
    result.tasksHover = stats(intervalsSince(mark))
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
