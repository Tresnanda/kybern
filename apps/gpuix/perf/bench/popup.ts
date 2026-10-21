/** Popup open/close frame pacing on any build that has `[kybern-frame]` and `[kybern-work]` (v0.10.1 onwards).
 *
 *   bun perf/bench/popup.ts <label> <scenario...> [--opens 25] [--env K=V ...]
 *
 * Seeds the shared bench dataset (perf/bench/seed.ts; `KYBERN_DATA_DIR`, `KYBERN_BENCH_PORT`), launches perf/bench/app.ts
 * on the hidden test display under one UI lease per scenario, opens the 3,000-turn thread and opens and closes a popup
 * with real pointer clicks and Escape (`POPUP_THREAD=short`: a thread with little history). Reports, over all opens:
 * - `frames`: intervals between consecutive presents inside a burst (gaps over 100 ms are idle, not frames), from the
 *   click to the end of the close: p50/p95/max and the count over 33 ms;
 * - `mount`: the first present after the click (ms after the click) and its draw cost (`renderMs`, `layoutMs`);
 * - footprint at the end. `KYBERN_FULL_RATE=1` is set unless `--env KYBERN_FULL_RATE=` overrides it.
 * The first visible step needs the native motion trace (perf/motion-native/latency.ts, branch addons only).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { seed } from './seed.ts'
import { lease } from './lease.ts'
import { requireScreen } from './screen-state.ts'
import { waitForWindowOnscreen, requireWindowOnscreen } from './window-onscreen.ts'
import { launchFixture } from '../../src/requests/harness.ts'
import { footprintMiB } from '../../scripts/idle-metrics.ts'

const root = path.resolve(import.meta.dir, '../..')
const argv = process.argv.slice(2)
const flag = (name: string) => { const i = argv.indexOf(name); if (i < 0) return undefined; const v = argv[i + 1]; argv.splice(i, 2); return v }
const extraEnv: Record<string, string> = { KYBERN_FULL_RATE: '1' }
for (let i = argv.indexOf('--env'); i >= 0; i = argv.indexOf('--env')) { const [k, ...v] = argv[i + 1]!.split('='); extraEnv[k!] = v.join('='); argv.splice(i, 2) }
const opens = Number(flag('--opens') ?? 25)
const [label, ...scenarios] = argv
if (!label || !scenarios.length) throw Error('usage: popup.ts <label> <scenario...>')
const DATA = process.env.KYBERN_DATA_DIR ?? '/Users/mymac/projects/ade-gpuix-scratch/popup-bench'
const OUT = process.env.KYBERN_BENCH_EVIDENCE ?? '/Users/mymac/projects/ade/previews/gpuix/perf/popup'
mkdirSync(OUT, { recursive: true })
const delay = (ms: number) => Bun.sleep(ms)
type Launch = Awaited<ReturnType<typeof launchFixture>>
type Bounds = { x: number; y: number; width: number; height: number }
async function until<T>(check: () => Promise<T | false | null | undefined>, message: string, timeout = 30000): Promise<T> {
  const end = performance.now() + timeout
  for (;;) { const v = await check(); if (v) return v; if (performance.now() > end) throw Error(message); await delay(30) }
}
async function bounds(app: Launch['app'], id: string): Promise<Bounds> {
  return until(async () => { try { for (const { bounds: b } of await app.getByTestId(id).all()) { if (b && b.width > 0 && b.height > 0 && b.x >= 0 && b.y >= 60) return b } return false } catch { return false } }, `No bounds: ${id}`)
}
const centre = (b: Bounds) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 })
const fixture = await seed(DATA, Number(process.env.KYBERN_BENCH_PORT ?? 4322))
const manifest = fixture.manifest
const SCENES: Record<string, { target: (app: Launch['app']) => Promise<Bounds>; button?: number }> = {
  'model-picker': { target: app => bounds(app, 'model-picker') },
  'mode-picker': { target: app => bounds(app, 'mode-picker') },
  'context-menu': { target: async app => { for (const id of manifest.threads.slice(0, 40)) { try { return await bounds(app, `thread-${id}`) } catch {} } throw Error('No sidebar thread row') }, button: 2 },
}
const q = (a: number[], p: number) => a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))]! : NaN
for (const name of scenarios) {
  const scene = SCENES[name]
  if (!scene) throw Error(`Unknown scenario ${name}`)
  const release = await lease()
  let f: Launch | undefined
  // [kybern-frame] <ms> stamps, and each frame's draw cost (the [kybern-work] line printed for the frame before it).
  const frames: { t: number; draw?: number; layout?: number }[] = []
  let rest = '', work: { draw: number; layout: number } | undefined, clock = 0
  const row: Record<string, unknown> = { label, scenario: name, at: new Date().toISOString(), env: extraEnv, opens }
  try {
    const client = path.join(DATA, 'client', `${label}-${name}`); mkdirSync(client, { recursive: true })
    f = await launchFixture(path.join(root, 'perf/bench/app.ts'), {
      ...fixture.env, KYBERN_CLIENT_CONFIG_DIR: client, KYBERN_GPUIX_CREDENTIALS_DIR: path.join(client, 'credentials'),
      GPUIX_BACKGROUND: '1', KYBERN_FRAME_TIMES: '1', KYBERN_FRAME_COSTS: '1', KYBERN_PACING_IGNORE_PHYSICAL_MOUSE: '1',
      KYBERN_GPUIX_THREAD: '', KYBERN_APPEARANCE: 'dark', NAPI_RS_NATIVE_LIBRARY_PATH: path.join(root, 'native/build/gpuix-native.darwin-arm64.node'), ...extraEnv,
    }, { stderr: chunk => {
      const lines = (rest + chunk).split('\n'); rest = lines.pop() ?? ''
      for (const l of lines) {
        const w = /\[kybern-work\] renderMs=([\d.]+) layoutMs=([\d.]+)/.exec(l); if (w) { work = { draw: Number(w[1]), layout: Number(w[2]) }; continue }
        const m = /\[kybern-frame\] ([\d.]+)/.exec(l); if (m) { clock = Number(m[1]); frames.push({ t: clock, ...(work ?? {}) }); work = undefined }
      }
    } })
    const app = f.app
    await bounds(app, 'app-ready').catch(() => app.getByTestId('app-ready').waitFor({ timeoutMs: 60000 }))
    const controlFile = path.join(client, 'bench-control.json')
    await until(async () => existsSync(controlFile), 'No bench control server')
    const port = JSON.parse(readFileSync(controlFile, 'utf8')).port
    const control = async (action: string, args: object = {}) => { const res = await fetch(`http://127.0.0.1:${port}`, { method: 'POST', body: JSON.stringify({ action, ...args }) }); return await res.json() }
    await waitForWindowOnscreen(f.pid, 60_000)
    // `POPUP_THREAD=short`: a seeded thread with little history instead of the 3,000-turn one.
    await control('idle'); await control('open', { thread: process.env.POPUP_THREAD === 'short' ? manifest.threads[3] : manifest.long3000 })
    await delay(4000)
    requireScreen(); requireWindowOnscreen(f.pid)
    const b = await scene.target(app)
    const intervals: number[] = [], mounts: { after: number; draw?: number; layout?: number }[] = [], timelines: string[][] = []
    for (let i = 0; i < opens; i++) {
      await app.mouse.move(centre(b)); await delay(300)
      const from = frames.length
      await app.mouse.click(centre(b), scene.button ? { button: scene.button } : undefined)
      await delay(600)
      await app.getByTestId('app-ready').press('escape')
      await delay(500)
      const burst = frames.slice(from)
      // The mount: the first frame after the click that is not the click's own hover/press repaint is not separable
      // without a trace; report the slowest of the first three frames (the popup's mount frame).
      const firstThree = burst.slice(0, 3)
      const mount = firstThree.reduce<typeof firstThree[number] | undefined>((m, fr) => (!m || (fr.draw ?? 0) > (m.draw ?? 0) ? fr : m), undefined)
      if (mount) mounts.push({ after: mount.t - (burst[0]?.t ?? mount.t), draw: mount.draw, layout: mount.layout })
      for (let k = 1; k < burst.length; k++) { const gap = burst[k]!.t - burst[k - 1]!.t; if (gap < 100) intervals.push(gap) }
      // The first opens' frames: gap since the previous present, draw and layout ms.
      if (i < 4) timelines.push(burst.map((fr, k) => `${k ? (fr.t - burst[k - 1]!.t).toFixed(1) : '-'}:${fr.draw?.toFixed(1) ?? '?'}/${fr.layout?.toFixed(1) ?? '?'}`))
    }
    intervals.sort((a, c) => a - c)
    const draws = mounts.flatMap(m => m.draw ?? []).sort((a, c) => a - c), layouts = mounts.flatMap(m => m.layout ?? []).sort((a, c) => a - c)
    Object.assign(row, {
      frames: { count: intervals.length, p50: q(intervals, 0.5), p95: q(intervals, 0.95), max: intervals.at(-1), over33: intervals.filter(v => v > 33.4).length, over20: intervals.filter(v => v > 20).length },
      mountDraw: { p50: q(draws, 0.5), p95: q(draws, 0.95), max: draws.at(-1) }, mountLayout: { p50: q(layouts, 0.5), p95: q(layouts, 0.95) },
      footprintMiB: footprintMiB(f.pid), timelines,
    })
    requireScreen(); requireWindowOnscreen(f.pid)
    row.valid = true
  } catch (error) { row.valid = false; row.error = String(error).slice(0, 2000) }
  finally { await f?.close(); release() }
  writeFileSync(path.join(OUT, `${label}-${name}.json`), JSON.stringify(row, null, 1))
  console.log(`${label} ${name} valid=${row.valid} frames=${JSON.stringify(row.frames)} mountDraw=${JSON.stringify(row.mountDraw)} mountLayout=${JSON.stringify(row.mountLayout)} MiB=${row.footprintMiB}${row.error ? ' ERROR ' + row.error : ''}`)
}
await fixture.close()
