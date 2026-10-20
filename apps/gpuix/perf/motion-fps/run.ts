/** Motion frame-rate and resource probe (lane motion/fps).
 *
 *   bun perf/motion-fps/run.ts <label> <scenario...> [--env K=V ...] [--warmup s] [--seconds s] [--keep-data]
 *
 * Seeds the shared bench dataset (perf/bench/seed.ts: 300 threads in 20 projects, 1,000/3,000-turn
 * threads, a synthetic running thread) on scratch port 4361, then launches the unchanged full app through
 * perf/bench/app.ts (pacing instrumentation + bench control server) on the hidden test display, one
 * UI lease per scenario (perf/bench/lease.ts: queue, screen gate, scoped caffeinate).
 *
 * Passive scenarios (loops) warm up, then sample native submissions, full draws, React commits, CPU,
 * AGX GPU time and footprint over one window. Transient scenarios trigger one motion repeatedly and
 * report the intervals between submissions inside each motion's duration.
 * Results append to previews/motion/fps/results.jsonl; every row states its env and addon hash.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { seed } from '../bench/seed.ts'
import { lease } from '../bench/lease.ts'
import { Telemetry } from '../bench/telemetry.ts'
import { distribution } from '../bench/model.ts'
import { requireScreen } from '../bench/screen-state.ts'
import { waitForWindowOnscreen, requireWindowOnscreen } from '../bench/window-onscreen.ts'
import { launchFixture } from '../../src/requests/harness.ts'
import { cpuSeconds, gpuNs, footprintMiB } from '../../scripts/idle-metrics.ts'

const DATA = '/Users/mymac/projects/ade-gpuix-scratch/motion-fps'
const PORT = 4361
const OUT = '/Users/mymac/projects/ade/previews/motion/fps'
const root = path.resolve(import.meta.dir, '../..')
const addon = path.join(root, 'native/build/gpuix-native.darwin-arm64.node')

const argv = process.argv.slice(2)
const flag = (name: string) => { const i = argv.indexOf(name); if (i < 0) return undefined; const v = argv[i + 1]; argv.splice(i, 2); return v }
const extraEnv: Record<string, string> = {}
for (let i = argv.indexOf('--env'); i >= 0; i = argv.indexOf('--env')) { const [k, ...v] = argv[i + 1]!.split('='); extraEnv[k!] = v.join('='); argv.splice(i, 2) }
const warmup = Number(flag('--warmup') ?? 10)
const seconds = Number(flag('--seconds') ?? 15)
const repeats = Number(flag('--repeats') ?? 1)
const keep = argv.includes('--keep-data'); if (keep) argv.splice(argv.indexOf('--keep-data'), 1)
const [label, ...scenarios] = argv
if (!label || !scenarios.length) throw Error('usage: run.ts <label> <scenario...>')
mkdirSync(OUT, { recursive: true })

const buildMarkers = () => existsSync('/tmp') ? readdirSync('/tmp').filter(n => n.startsWith('kybern-gpuix-native-build.')) : []
// Any other GPUIX app, fixture or lab (every lane's checkout) skews a timing window.
const foreignApps = (pid: number) => Bun.spawnSync(['pgrep', '-fl', 'bun .*/apps/gpuix/']).stdout.toString().split('\n').filter(l => l.trim() && !l.startsWith(`${pid} `) && !l.includes('motion-fps/run.ts'))
const sha = createHash('sha256').update(readFileSync(addon)).digest('hex').slice(0, 16)

const fixture = await seed(DATA, PORT)
const manifest = fixture.manifest
const delay = (ms: number) => Bun.sleep(ms)
type Launch = Awaited<ReturnType<typeof launchFixture>>

async function until<T>(check: () => Promise<T | false | null | undefined>, message: string, timeout = 30000): Promise<T> {
  const end = performance.now() + timeout
  for (;;) { const v = await check(); if (v) return v; if (performance.now() > end) throw Error(message); await delay(30) }
}
async function bounds(app: Launch['app'], id: string) {
  return until(async () => { try { const b = await app.getByTestId(id).bounds(); return b.width > 0 && b.height > 0 ? b : false } catch { return false } }, `No bounds: ${id}`)
}
async function click(app: Launch['app'], id: string) { const b = await bounds(app, id); await app.mouse.click({ x: b.x + b.width / 2, y: b.y + b.height / 2 }) }

function setTasks(status: 'running' | 'restore') {
  const db = new Database(path.join(DATA, 'state.sqlite'))
  try {
    if (status === 'running') db.query("UPDATE task_items SET status='running' WHERE rowid % 2 = 0").run()
    else db.query("UPDATE task_items SET status=CASE WHEN rowid % 2 = 1 THEN 'todo' ELSE 'inbox' END").run()
  } finally { db.close() }
}

/** Each scenario prepares its view after launch; `motion` (transient) returns the trigger and its duration. */
const SCENES: Record<string, { open: (app: Launch['app'], control: (a: string, b?: object) => Promise<unknown>) => Promise<void>; transient?: { ms: number; trigger: (app: Launch['app'], i: number) => Promise<void> }; before?: () => void; after?: () => void }> = {
  'idle-home': { open: async (_, c) => { await c('idle'); await c('home') } },
  'idle-thread': { open: async (_, c) => { await c('idle'); await c('open', { thread: manifest.long3000 }) } },
  'home-running': { open: async (_, c) => { await c('home') } },
  'thread-running': { open: async (app, c) => { await c('open', { thread: manifest.running }); await c('turn-started'); await bounds(app, 'working-header') } },
  'tasks-running': {
    before: () => setTasks('running'), after: () => setTasks('restore'),
    open: async (app, c) => { await c('home'); await click(app, 'rail-tasks'); await click(app, 'task-filter-all'); if (await app.getByTestId('task-view-board').count()) await click(app, 'task-view-board') },
  },
  // Transient motions in a heavy window (the 3,000-turn thread), each toggled 12 times.
  'sidebar-toggle': { open: async (_, c) => { await c('idle'); await c('open', { thread: manifest.long3000 }) }, transient: { ms: 220, trigger: app => click(app, 'sidebar-toggle') } },
  'dock-toggle': { open: async (_, c) => { await c('idle'); await c('open', { thread: manifest.long3000 }) }, transient: { ms: 300, trigger: app => click(app, 'dock-toggle') } },
  'model-picker': { open: async (_, c) => { await c('idle'); await c('open', { thread: manifest.long3000 }) }, transient: { ms: 250, trigger: async (app, i) => { if (i % 2) await app.keyboard.press('Escape'); else await click(app, 'model-picker') } } },
}

const results: unknown[] = []
for (const name of scenarios) for (let repeat = 1; repeat <= repeats; repeat++) {
  const scene = SCENES[name]
  if (!scene) throw Error(`Unknown scenario ${name}`)
  const release = await lease()
  const t = new Telemetry()
  let f: Launch | undefined
  const row: Record<string, unknown> = { label, scenario: name, repeat, at: new Date().toISOString(), addon: sha, env: extraEnv, warmup, seconds }
  try {
    scene.before?.()
    const client = path.join(DATA, 'client', `${label}-${name}`); mkdirSync(client, { recursive: true })
    const markers0 = buildMarkers(), foreign0 = foreignApps(0)
    f = await launchFixture(path.join(root, 'perf/bench/app.ts'), {
      ...fixture.env, KYBERN_CLIENT_CONFIG_DIR: client, KYBERN_GPUIX_CREDENTIALS_DIR: path.join(client, 'credentials'),
      GPUIX_BACKGROUND: '1', KYBERN_FRAME_TIMES: '1', KYBERN_FRAME_COSTS: '1', KYBERN_PACING_IGNORE_PHYSICAL_MOUSE: '1',
      KYBERN_GPUIX_THREAD: '', KYBERN_APPEARANCE: extraEnv.KYBERN_APPEARANCE ?? 'dark', NAPI_RS_NATIVE_LIBRARY_PATH: addon, ...extraEnv,
    }, { stderr: t.stderr })
    const app = f.app
    await bounds(app, 'app-ready')
    const controlFile = path.join(client, 'bench-control.json')
    await until(async () => existsSync(controlFile), 'No bench control server')
    const port = JSON.parse(readFileSync(controlFile, 'utf8')).port
    const control = async (action: string, args: object = {}) => {
      const res = await fetch(`http://127.0.0.1:${port}`, { method: 'POST', body: JSON.stringify({ action, ...args }) })
      const body = await res.json() as { error?: string }; if (!res.ok) throw Error(body.error); return body
    }
    await waitForWindowOnscreen(f.pid, 60_000)
    await scene.open(app, control)
    // Park the synthetic pointer outside controls: a hovered tooltip is a different workload.
    const win = (await app.call('initialize', { protocolVersion: 1, client: 'motion-fps' })).window
    await app.mouse.move({ x: win.width - 4, y: win.height - 4 })
    await delay(warmup * 1000)
    requireScreen(); requireWindowOnscreen(f.pid)
    if (scene.transient) {
      const samples: number[][] = [], draws: number[] = []
      for (let i = 0; i < 12; i++) {
        const mark = t.mark()
        await scene.transient.trigger(app, i)
        await delay(scene.transient.ms + 250)
        const frames = t.submissions.slice(mark.frames).map(s => s.native)
        samples.push(frames.slice(1).map((v, j) => v - frames[j]!).filter(v => v < scene.transient!.ms + 100))
        draws.push(t.costs.length - mark.costs)
      }
      const all = samples.flat()
      Object.assign(row, { frames: { ...distribution(all), count: all.length, over16_7: all.filter(v => v > 16.7).length, over33: all.filter(v => v > 33).length }, framesPerMotion: samples.map(s => s.length + 1), fullDraws: draws, work: t.result({ frames: 0, costs: 0, commits: 0 }).work })
    } else {
      const mark = t.mark(), c0 = cpuSeconds(f.pid), g0 = gpuNs().get(f.pid) ?? 0, s0 = performance.now()
      // Diagnostic only: `sample` itself costs CPU, so a profiled row is never a resource result.
      const profile = process.env.MOTION_PROFILE === '1' ? Bun.spawn(['sample', String(f.pid), String(Math.min(seconds, 10)), '-file', path.join(OUT, `profile-${label}-${name}.txt`)], { stdout: 'pipe', stderr: 'pipe' }) : undefined
      if (profile) row.profiled = true
      await delay(seconds * 1000)
      if (profile) { await profile.exited; row.profileOutput = (await new Response(profile.stderr).text()).slice(-500) + (await new Response(profile.stdout).text()).slice(-300) }
      const elapsed = (performance.now() - s0) / 1000, c1 = cpuSeconds(f.pid), g1 = gpuNs().get(f.pid) ?? 0
      const r = t.result(mark)
      Object.assign(row, { seconds: elapsed, frames: r.frames, fps: r.frames.count / elapsed, fullDraws: t.costs.length - mark.costs, work: r.work, cpuPercent: 100 * (c1 - c0) / elapsed, gpuMs: (g1 - g0) / 1e6, footprintMiB: footprintMiB(f.pid) })
    }
    requireScreen(); requireWindowOnscreen(f.pid)
    const markers1 = buildMarkers(), foreign = [...foreign0, ...foreignApps(f.pid)]
    row.valid = !markers0.length && !markers1.length && !foreign.length && !row.profiled
    row.buildMarkers = [...markers0, ...markers1]; row.foreign = foreign
    writeFileSync(path.join(OUT, `log-${label}-${name}-${repeat}.txt`), t.raw.split('\n').filter(l => !/\[kybern-(submit|frame|work)\]|\[pacing-commit\]/.test(l)).slice(-400).join('\n'))
  } catch (error) { row.valid = false; row.error = String(error).slice(0, 2000) }
  finally { await f?.close(); scene.after?.(); release() }
  appendFileSync(path.join(OUT, 'results.jsonl'), JSON.stringify(row) + '\n')
  results.push(row)
  const fr = row.frames as { p50: number; p95: number; p99: number; count: number; over16_7: number; over33: number } | undefined
  console.log(`${label} ${name}#${repeat} valid=${row.valid} frames=${fr?.count} p50/p95/p99=${fr?.p50?.toFixed(2)}/${fr?.p95?.toFixed(2)}/${fr?.p99?.toFixed(2)} >16.7=${fr?.over16_7} >33=${fr?.over33} draws=${JSON.stringify(row.fullDraws)} commits=${(row.work as { reactCommits?: number } | undefined)?.reactCommits} cpu=${(row.cpuPercent as number | undefined)?.toFixed(2)} gpu=${(row.gpuMs as number | undefined)?.toFixed(1)} MiB=${(row.footprintMiB as number | undefined)?.toFixed(0)}${row.error ? ' ERROR ' + row.error : ''}`)
}
await fixture.close()
if (!keep) fixture.remove()
