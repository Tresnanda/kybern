// Frame intervals for the update surfaces' motion (scene submissions from
// KYBERN_FRAME_TIMES, as in scripts/shell3-perf.ts): the announcement entrance
// (350 ms) and exit (250 ms), the rail card open and the details dialog open,
// then 2 s of idle. The harness writes `[mark]` lines into the same trace before
// each step, so a step's frames are the first contiguous burst (gaps < 100 ms)
// after its mark, however late the automation notices the change. No
// screenshots or manual clocks during the run.
//
//   KYBERN_DATA_DIR=<scratch> bun src/platform/verify.motion.ts <out.json> [reduced]
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { connectStdio } from '@gpuix/react/automation'
import { assertScratchDataDir } from './verify.lib.ts'

const [out = '/tmp/update-motion.json', motion] = process.argv.slice(2)
const client = path.join(assertScratchDataDir(), 'client-motion')
mkdirSync(client, { recursive: true })
const trace = `${out}.trace`
writeFileSync(trace, '')
const child = spawn('bun', [path.join(import.meta.dir, 'update.fixture.ts')], { stdio: ['pipe', 'pipe', 'pipe'], env: {
  ...process.env, GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: 'dark', KYBERN_FRAME_TIMES: '1', KYBERN_UPDATE_FIRST_CHECK_MS: '6000',
  KYBERN_REDUCED_MOTION: motion === 'reduced' ? '1' : '0', KYBERN_CLIENT_CONFIG_DIR: client,
} })
child.stderr.on('data', chunk => appendFileSync(trace, chunk))
const watchdog = setTimeout(() => child.kill(), 90_000)
const app = await connectStdio({ write: chunk => { child.stdin.write(chunk) }, feed: listener => child.stdout.on('data', chunk => listener(String(chunk))), close: async () => { child.kill() } })
const mark = (label: string) => appendFileSync(trace, `[mark] ${label}\n`)

/** Frames after `[mark] label` and before the next mark. */
function framesAfter(label: string) {
  const lines = readFileSync(trace, 'utf8').split('\n')
  const start = lines.indexOf(`[mark] ${label}`)
  const times: number[] = []
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('[mark]')) break
    const m = /\[kybern-frame\] ([\d.]+)/.exec(line)
    if (m) times.push(Number(m[1]))
  }
  return times
}
function burst(times: number[]) {
  const first: number[] = []
  for (const t of times) { if (first.length && t - first.at(-1)! >= 100) break; first.push(t) }
  const deltas = first.slice(1).map((t, i) => t - first[i]!).sort((a, b) => a - b)
  return { frames: first.length, spanMs: first.length ? Math.round(first.at(-1)! - first[0]!) : 0, p50: deltas[Math.floor(deltas.length * 0.5)] ?? null, p95: deltas[Math.floor(deltas.length * 0.95)] ?? null, max: deltas.at(-1) ?? null }
}

const result: Record<string, unknown> = { fullRate: process.env.KYBERN_FULL_RATE ?? 'unset', reducedMotion: motion === 'reduced', kind: 'scene submissions, not compositor presentations; first contiguous burst after each step' }
try {
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
  await Bun.sleep(2000)
  mark('enter')
  await app.getByTestId('update-announcement').waitFor({ timeoutMs: 20_000 })
  await Bun.sleep(1200)
  mark('exit')
  await app.getByTestId('update-announcement-dismiss').click()
  await Bun.sleep(1200)
  mark('card')
  await app.getByTestId('rail-update').click()
  await Bun.sleep(1000)
  mark('details')
  await app.getByTestId('rail-update-details').click()
  await Bun.sleep(1500)
  mark('idle')
  await Bun.sleep(2000)
  mark('end')
  for (const [key, label] of [['announcementEnter', 'enter'], ['announcementExit', 'exit'], ['railCardOpen', 'card'], ['detailsOpen', 'details']] as const) result[key] = burst(framesAfter(label))
  result.idleFrames = framesAfter('idle').length
  writeFileSync(out, JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
} finally { clearTimeout(watchdog); await app.close(); if (child.exitCode === null) child.kill() }
process.exit(0)
