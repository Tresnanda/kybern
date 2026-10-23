// Work runs, cost while a busy turn streams (perf/work-groups-2026-10-23.md). The full app on the glass scratch daemon, Solid
// dark, 1000×900, a live turn fed at 25 events/s by `perf/bench/workTurn.ts` (reasoning, narration, four calls per segment,
// every seventh call failing) on top of 44 historical ticks. Variants alternate A B B A: `before` serves the GPUIX and
// kybern-client sources of `--before <commit>` (`perf/glass/baseline.ts`; `apps/desktop/src` is the working tree's in both),
// `after` the working tree. Per run: 8 s warm-up, then three 10 s windows of scene-submission intervals, full draws with their
// render and layout ms (`KYBERN_FRAME_COSTS`), React commits, and the app's CPU, GPU and footprint (`perf/sample.ts`).
//
//   KYBERN_DATA_DIR=<…gpuix-scratch…/data> bun src/transcript/work.perf.ts --before 84d44d0dd [--out <json>] [--open]
//
// `--open` opens every run as it mounts (members arriving in open groups, the heavier case for the new rows).
// `--unleased` skips the shared UI lease and its awake-screen gate: a diagnostic for a sleeping display (the screen state is
// recorded; frame numbers from such a run are not valid measurements).
//
// Mounted host elements and components under the transcript are counted after each window (`counters`, a fiber walk).
import '../native/local-build.ts'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { distribution } from '../../perf/bench/model.ts'
import { onExit } from '../../perf/bench/lifetime.ts'
import { lease } from '../../perf/bench/lease.ts'
import { parseResources, Telemetry } from '../../perf/bench/telemetry.ts'
import { controlFor, ensureTestDisplay, waitForQuiet } from '../../perf/glass/harness.ts'
import { seedGlass } from '../../perf/glass/seed.ts'
import { launchFixture } from '../requests/harness.ts'
import { assertScratchDataDir, until } from '../platform/verify.lib.ts'

assertScratchDataDir()
const argv = process.argv.slice(2)
const arg = (name: string, fallback: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1]! : fallback)
const before = arg('--before', ''), out = arg('--out', '/Users/mymac/projects/ade/.kybern-artifacts/ade-54-58/L5/perf/work-perf.json')
const open = argv.includes('--open'), unleased = argv.includes('--unleased'), windows = Number(arg('--windows', '3')), seconds = Number(arg('--seconds', '10'))
if (!before) throw Error('Pass --before <commit>')
const GPUIX = path.resolve(import.meta.dir, '../..')
mkdirSync(path.dirname(out), { recursive: true })

if (!(await waitForQuiet())) throw Error('Another agent\'s native build or check is still running after 20 minutes.')
const fixture = await seedGlass()
const unFixture = onExit(() => fixture.close())
const stopDisplay = await ensureTestDisplay(path.join(fixture.extras, 'bin'))
const unDisplay = onExit(stopDisplay)
const release = unleased ? () => {} : await lease()
const screen = execFileSync('swift', ['/Users/mymac/projects/ade-gpuix-scratch/screen-state.swift'], { encoding: 'utf8' }).trim().replace(/\n/g, ' ')

const rows: Record<string, unknown>[] = []
for (const [i, variant] of (['before', 'after', 'after', 'before'] as const).entries()) {
  const client = path.join(fixture.extras, 'clients', `work-perf-${i}`)
  rmSync(client, { recursive: true, force: true }); mkdirSync(client, { recursive: true })
  const t = new Telemetry()
  const run = await launchFixture(path.join(GPUIX, 'src/transcript/work.app.ts'), {
    ...fixture.env, KYBERN_WINDOW_MATERIAL: 'solid', KYBERN_CLIENT_CONFIG_DIR: client, KYBERN_GPUIX_CREDENTIALS_DIR: path.join(client, 'credentials'),
    KYBERN_GPUIX_ENVIRONMENT: 'local', KYBERN_GPUIX_THREAD: fixture.manifest.thread, KYBERN_GLASS_THREAD: fixture.manifest.thread,
    GPUIX_BACKGROUND: '1', KYBERN_BENCH_LAYER_ZERO: '1', KYBERN_PACING_IGNORE_PHYSICAL_MOUSE: '1', KYBERN_APPEARANCE: 'dark',
    KYBERN_REDUCED_MOTION: '0', KYBERN_WINDOW_SIZE: '1000x900', KYBERN_FULL_RATE: '1', KYBERN_FRAME_TIMES: '1', KYBERN_FRAME_COSTS: '1',
    ...(variant === 'before' ? { KYBERN_GLASS_BASELINE: before } : {}),
  }, { stderr: t.stderr })
  try {
    await run.app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
    const glass = await controlFor(client)
    const port = async () => (JSON.parse(await Bun.file(path.join(client, 'work-control.json')).text()) as { port: number }).port
    const work = async (action: string, args: object = {}) => { const res = await fetch(`http://127.0.0.1:${await port()}`, { method: 'POST', body: JSON.stringify({ action, ...args }) }); if (!res.ok) throw Error(await res.text()); return await res.json() as Record<string, unknown> }
    await glass('open-fixture-thread')
    await until(async () => { const s = await glass<{ loaded: boolean; blocks: number }>('state'); return s.loaded && s.blocks > 0 }, 'the thread loads', 30_000)
    await run.app.mouse.move({ x: 24, y: 640 })
    if (open) await work('open', { match: ':group:' })
    await work('turn', { turn: `work-perf-${i}`, history: 44, ago: 40 })
    await work('feed', { count: 100_000, intervalMs: 40 })
    await Bun.sleep(8000)
    for (let w = 0; w < windows; w++) {
      const mark = t.mark()
      const sample = execFileSync('bun', [path.join(GPUIX, 'perf/sample.ts'), String(seconds), `GPUIX=${run.pid}`], { encoding: 'utf8' })
      const r = t.result(mark)
      const costs = t.costs.slice(mark.costs)
      const state = await work('counters').catch(() => ({}))
      rows.push({ variant, run: i, window: w, screen, frames: r.frames, fullDraws: costs.length, renderMs: distribution(costs.map((c) => c.render)), layoutMs: distribution(costs.map((c) => c.layout)), reactCommits: t.commits - mark.commits, resources: parseResources(sample), ...state })
      console.log(`${variant.padEnd(6)} run ${i} w${w}: frames p50/p95/p99 ${r.frames.p50?.toFixed(1)}/${r.frames.p95?.toFixed(1)}/${r.frames.p99?.toFixed(1)} n=${r.frames.count} >16.7=${r.frames.over16_7} | draws ${costs.length} render p50/p95 ${distribution(costs.map((c) => c.render)).p50?.toFixed(2)}/${distribution(costs.map((c) => c.render)).p95?.toFixed(2)} layout p95 ${distribution(costs.map((c) => c.layout)).p95?.toFixed(2)} | commits ${t.commits - mark.commits} | ${sample.match(/total.*$/m)?.[0]}`)
    }
  } catch (error) {
    console.log(`FAIL ${variant} ${i}: ${String(error).slice(0, 400)}\n${run.diagnostics().split('\n').filter((l) => !l.includes('[pacing-commit]') && !l.includes('[kybern-')).join('\n').slice(-1200)}`)
  } finally { await run.close() }
}
writeFileSync(out, JSON.stringify({ before, open, unleased, screen, windows, seconds, workload: '25 events/s busy turn (perf/bench/workTurn.ts), 44 historical ticks, Solid dark 1000x900, KYBERN_FULL_RATE=1', rows }, null, 1))
release(); unDisplay(); stopDisplay(); unFixture(); await fixture.close()
process.exit(0)
