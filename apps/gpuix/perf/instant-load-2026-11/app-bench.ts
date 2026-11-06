/**
 * In-app measurement (#248): the real GPUIX window against a scratch daemon, KYBERN_STARTUP_TRACE=1, with the
 * sidebar rows clicked through the addon's automation client (input synthesized in-process, no OS input).
 *
 *   bun perf/instant-load-2026-11/app-bench.ts --daemon <kybernd> --label <name> [--rounds 5] [--keep-cache]
 *
 * Cold start: app spawn → `lists-ready` and → `thread-first-content` / `thread-content-frame` of the restored long
 * thread (split state saved on it). Then rounds of clicks on the short, medium and long rows, each measured from
 * `thread-click` to `thread-first-content` and to the next native frame (`thread-content-frame`). A second launch on
 * the same data and client folder (`--keep-cache` keeps the client folder from the previous launch) measures a warm
 * restart. Requires the patched addon (`native/build`); the window opens in the background (KYBERN_NO_ACTIVATE=1).
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../../src/requests/harness.ts'
import { freshCopy, readFixture, startDaemon, SCRATCH } from './scratch.ts'
import { median, p95 } from './meter.ts'

const arg = (name: string, fallback?: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1]! : fallback }
const exe = path.resolve(arg('daemon') ?? (() => { throw Error('--daemon <kybernd> is required') })())
const label = arg('label', 'app')!
const rounds = Number(arg('rounds', '5'))
const launches = Number(arg('launches', '2'))
// `--app <main.tsx>`: another source tree's entry (the baseline: a copy of origin/main's apps/gpuix with this
// checkout's node_modules and native/build linked in), measured with this same harness.
const entry = path.resolve(arg('app', path.join(import.meta.dir, '../../src/main.tsx'))!)
const out = path.resolve(arg('out', path.join(import.meta.dir, 'results', `app-${label}.json`))!)
const fixture = readFixture()
const roles = { short: fixture.short, medium: fixture.medium, long: fixture.long } as const
/** The newest answer's heading of each thread: painted only once its content is on screen. */
const newest = { short: 'Result 4', medium: `Result ${fixture.mediumTurns}`, long: `Result ${fixture.longTurns}` } as const

type Mark = { phase: string; at: number; id?: string; ms?: number; from?: string; blocks?: number }
const dir = freshCopy(`app-${label}`)
const clientDir = path.join(SCRATCH, `app-${label}-client`)
if (!process.argv.includes('--keep-cache')) rmSync(clientDir, { recursive: true, force: true })
mkdirSync(clientDir, { recursive: true })
writeFileSync(path.join(dir, 'gpuix-ui.json'), JSON.stringify({ 'kybern.split-view.v1': { version: 1, root: { kind: 'leaf', id: 'main', threadId: fixture.long }, focusedPaneId: 'main' } }))
const daemon = await startDaemon(exe, dir, 4423)
const results: Record<string, unknown>[] = []
const timelines: { spawnedAt: number; marks: Mark[] }[] = []
try {
  // `--warmup`: one untimed launch first (Bun's transpile cache for a source tree it has not run yet).
  const warmup = process.argv.includes('--warmup')
  for (let launch = warmup ? -1 : 0; launch < launches; launch++) {
    const marks: Mark[] = []
    let rest = ''
    const spawnedAt = Date.now()
    timelines.push({ spawnedAt, marks })
    const f = await launchFixture(entry, {
      GPUIX_BACKGROUND: '1', KYBERN_NO_ACTIVATE: '1', KYBERN_STARTUP_TRACE: '1', KYBERN_APPEARANCE: 'dark',
      KYBERN_DATA_DIR: dir, KYBERN_CLIENT_CONFIG_DIR: clientDir, KYBERN_URL: '', KYBERN_TOKEN: '', KYBERN_GPUIX_THREAD: '',
    }, { stderr: chunk => {
      const lines = (rest + chunk).split('\n'); rest = lines.pop() ?? ''
      for (const line of lines) { const m = line.match(/\[kybern-startup\] (\{.*\})/); if (m) try { marks.push(JSON.parse(m[1]!)) } catch {} }
    } })
    const waitMark = async (pred: (m: Mark) => boolean, timeoutMs = 30_000, from = 0) => {
      const deadline = Date.now() + timeoutMs
      for (;;) { const found = marks.slice(from).find(pred); if (found) return found; if (Date.now() > deadline) return undefined; await Bun.sleep(5) }
    }
    try {
      await f.app.getByTestId('app-ready').waitFor({ timeoutMs: 90_000 })
      const lists = await waitMark(m => m.phase === 'lists-ready', 60_000)
      const restored = await waitMark(m => m.phase === 'thread-content-frame' && m.id === fixture.long, 60_000)
      const restoredContent = marks.find(m => m.phase === 'thread-first-content' && m.id === fixture.long)
      results.push({ case: `launch${launch + 1}-lists-ready`, ms: lists ? lists.at - spawnedAt : NaN })
      results.push({ case: `launch${launch + 1}-restore-long-content`, ms: restoredContent ? restoredContent.at - spawnedAt : NaN, from: restoredContent?.from })
      results.push({ case: `launch${launch + 1}-restore-long-frame`, ms: restored ? restored.at - spawnedAt : NaN })
      await Bun.sleep(1500)
      for (let round = 0; round < rounds; round++) for (const [role, id] of Object.entries(roles)) {
        const row = f.app.getByTestId(`thread-${id}`)
        await row.waitFor({ timeoutMs: 90_000 })
        const from = marks.length
        const clicked = Date.now()
        await row.click()
        const content = await waitMark(m => m.phase === 'thread-first-content' && m.id === id, 20_000, from)
        const frame = await waitMark(m => m.phase === 'thread-content-frame' && m.id === id, 20_000, from)
        // Painted: the newest answer's heading is in the window's painted text (polled; bench clock, click included).
        let paintedMs = NaN
        for (const deadline = Date.now() + 20_000; Date.now() < deadline;) {
          const text = (await f.app.call('getPaintedText', {})).text as string[]
          if (text.some(line => line.trim() === newest[role as keyof typeof newest])) { paintedMs = Date.now() - clicked; break }
        }
        results.push({ case: `launch${launch + 1}-click-${role}`, ms: content?.ms ?? NaN, frameMs: frame?.ms ?? NaN, paintedMs, from: content?.from, blocks: content?.blocks, round })
        await Bun.sleep(400)
      }
    } finally { await f.close() }
    process.stderr.write(`launch ${launch + 1} done (${marks.length} marks)\n`)
    // The warm-up leaves no transcript cache behind: launch 1 starts without one, later launches reuse launch 1's.
    if (launch < 0) { results.length = 0; timelines.length = 0; for (const end of ['', '-wal', '-shm']) rmSync(path.join(clientDir, `transcripts.sqlite${end}`), { force: true }) }
  }
} finally { await daemon.stop() }

const cases = [...new Set(results.map(r => r.case as string))]
const summary = Object.fromEntries(cases.map(name => {
  const xs = results.filter(r => r.case === name)
  const ms = xs.map(r => Number(r.ms)).filter(Number.isFinite), frame = xs.map(r => Number(r.frameMs)).filter(Number.isFinite), painted = xs.map(r => Number(r.paintedMs)).filter(Number.isFinite)
  return [name, { n: xs.length, medianMs: +median(ms).toFixed(1), p95Ms: +p95(ms).toFixed(1), ...(frame.length ? { frameMedianMs: +median(frame).toFixed(1) } : {}), ...(painted.length ? { paintedMedianMs: +median(painted).toFixed(1), paintedP95Ms: +p95(painted).toFixed(1) } : {}), from: [...new Set(xs.map(r => r.from).filter(Boolean))].join('/') }]
}))
mkdirSync(path.dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify({ label, daemon: path.basename(exe), rounds, launches, at: new Date().toISOString(), summary, results, timelines }, null, 2))
console.table(summary)
console.log(`wrote ${out}`)
