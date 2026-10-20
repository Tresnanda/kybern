// Toast cross-fade timing and behaviour in real time (no clock pause, no screenshots): scene-submission intervals for the
// entrance, a stacked arrival and the exit, idle frames once settled, and the hover X still dismissing.
//   bun scripts/toast9-perf.ts [--theme dark|light] [--reduced 0|1]
import '../src/native/local-build.ts'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../src/tasks/round7b-harness.ts'
const arg = (name: string, fallback: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1]! : fallback)
const theme = arg('--theme', 'dark'), reduced = arg('--reduced', '0')
const trace = `/Users/mymac/projects/ade-gpuix-scratch/toast9/frames-${theme}-${reduced}.log`
writeFileSync(trace, '')
process.env.R7_LOG = trace
const scratch = { KYBERN_DATA_DIR: '/Users/mymac/projects/ade-gpuix-scratch/toast9', KYBERN_CLIENT_CONFIG_DIR: '/Users/mymac/projects/ade-gpuix-scratch/toast9-client', KYBERN_URL: '', KYBERN_TOKEN: '' }
const f = await launchFixture(path.join(import.meta.dir, 'toast9-lab.tsx'), { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: theme, KYBERN_REDUCED_MOTION: reduced, KYBERN_OPAQUE: '1', KYBERN_FRAME_TIMES: '1', ...scratch })
const mark = (label: string) => appendFileSync(trace, `[mark] ${label}\n`)
const framesAfter = (label: string) => {
  const lines = readFileSync(trace, 'utf8').split('\n'), start = lines.indexOf(`[mark] ${label}`), times: number[] = []
  for (const line of lines.slice(start + 1)) { if (line.startsWith('[mark]')) break; const m = /\[kybern-frame\] ([\d.]+)/.exec(line); if (m) times.push(Number(m[1])) }
  return times
}
const burst = (times: number[]) => {
  const run: number[] = []
  for (const t of times) { if (run.length && t - run.at(-1)! >= 100) break; run.push(t) }
  const d = run.slice(1).map((t, i) => t - run[i]!).sort((a, b) => a - b)
  return { frames: run.length, spanMs: run.length ? Math.round(run.at(-1)! - run[0]!) : 0, p50: d[Math.floor(d.length * 0.5)] ?? null, p95: d[Math.floor(d.length * 0.95)] ?? null, max: d.at(-1) ?? null }
}
const result: Record<string, unknown> = { fullRate: process.env.KYBERN_FULL_RATE ?? 'unset', theme, reducedMotion: reduced === '1', kind: 'scene submissions, not compositor presentations; first contiguous burst' }
try {
  const a = f.app; await a.getByTestId('app-ready').waitFor()
  const rootId = (await a.getByTestId('app-ready').element()).id
  await a.call('focus', { elementId: rootId })
  await Bun.sleep(1500)
  const key = (k: string) => a.call('keyDown', { key: k })
  mark('enter'); await key('a'); await Bun.sleep(900)
  mark('stack'); await key('b'); await Bun.sleep(900)
  mark('replace'); await key('r'); await Bun.sleep(900)
  mark('idle'); await Bun.sleep(2500)
  // The hover X still dismisses: move onto the front card, click the close button, expect the stack to empty one by one.
  mark('exit')
  const before = await a.getByTestId('toast-default').count() + await a.getByTestId('toast-success').count()
  const card = await a.getByTestId('toast-success').center()
  await a.mouse.move(card)
  await a.getByTestId('toast-close').waitFor({ timeoutMs: 3000 })
  await a.getByTestId('toast-close').click()
  await Bun.sleep(900)
  mark('after-x')
  result.toastsBeforeX = before
  result.successToastsAfterX = await a.getByTestId('toast-success').count()
  result.enter = burst(framesAfter('enter')); result.stack = burst(framesAfter('stack')); result.replace = burst(framesAfter('replace'))
  const idle = framesAfter('idle').filter(t => t > 0)
  // Frames in the last 2 s of the 'idle' window (after the 0.9 s of the replace settle has long gone).
  result.idleFrames = idle.filter(t => t > idle[0]! + 500).length
  result.exit = burst(framesAfter('exit'))
  console.log(JSON.stringify(result, null, 1))
} finally { await f.close() }
process.exit(0)
