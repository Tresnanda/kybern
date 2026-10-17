// Frame intervals for the update surfaces' motion (scene submissions from
// KYBERN_FRAME_TIMES, as in scripts/shell3-perf.ts): the announcement entrance
// (350 ms) and exit (250 ms), the rail card open and the details dialog open.
// No screenshots or manual clocks during the run.
//
//   bun src/platform/verify.motion.ts <out.json> [reduced]
import { spawn } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { connectStdio } from '@gpuix/react/automation'

const [out = '/tmp/update-motion.json', motion] = process.argv.slice(2)
const trace = `${out}.trace`
writeFileSync(trace, '')
const child = spawn('bun', [path.join(import.meta.dir, 'update.fixture.ts')], { stdio: ['pipe', 'pipe', 'pipe'], env: {
  ...process.env, GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: 'dark', KYBERN_FRAME_TIMES: '1', KYBERN_UPDATE_FIRST_CHECK_MS: '6000',
  KYBERN_REDUCED_MOTION: motion === 'reduced' ? '1' : '0',
} })
child.stderr.on('data', chunk => appendFileSync(trace, chunk))
const app = await connectStdio({ write: chunk => { child.stdin.write(chunk) }, feed: listener => child.stdout.on('data', chunk => listener(String(chunk))), close: async () => { child.kill() } })
const frames = () => readFileSync(trace, 'utf8').split('\n').flatMap(line => { const m = /\[kybern-frame\] ([\d.]+)/.exec(line); return m ? [Number(m[1])] : [] })
const stats = (times: number[]) => {
  const deltas = times.slice(1).map((t, i) => t - times[i]!).sort((a, b) => a - b)
  return { frames: times.length, p50: deltas[Math.floor(deltas.length * 0.5)] ?? null, p95: deltas[Math.floor(deltas.length * 0.95)] ?? null, max: deltas.at(-1) ?? null }
}
async function burst(label: string, act: () => Promise<void>, ms: number) {
  const first = frames().length
  await act()
  await Bun.sleep(ms)
  return [label, stats(frames().slice(first))] as const
}
const result: Record<string, unknown> = { fullRate: process.env.KYBERN_FULL_RATE ?? 'unset', reducedMotion: motion === 'reduced', kind: 'scene submissions, not compositor presentations' }
try {
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
  await Bun.sleep(2000)
  const [, enter] = await burst('enter', async () => { await app.getByTestId('update-announcement').waitFor({ timeoutMs: 20_000 }) }, 450)
  if (process.env.DEBUG_FRAMES) console.log('all frames', JSON.stringify(frames()))
  result.announcementEnter = enter
  await Bun.sleep(800)
  result.announcementExit = (await burst('exit', () => app.getByTestId('update-announcement-dismiss').click(), 350))[1]
  await Bun.sleep(800)
  result.railCardOpen = (await burst('card', () => app.getByTestId('rail-update').click(), 350))[1]
  await Bun.sleep(600)
  result.detailsOpen = (await burst('details', () => app.getByTestId('rail-update-details').click(), 450))[1]
  await Bun.sleep(1500)
  result.idleAfter = (await burst('idle', async () => {}, 2000))[1]
  writeFileSync(out, JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
} finally { await app.close(); if (child.exitCode === null) child.kill() }
process.exit(0)
