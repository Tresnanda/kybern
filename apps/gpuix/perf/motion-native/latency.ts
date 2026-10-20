/** Input → first visible step of a popup or entrance (lane gpuix-native, N0).
 *
 *   bun perf/motion-native/latency.ts <label> <scenario...> [--env K=V ...] [--opens 12] [--keep-data]
 *
 * Seeds the shared bench dataset (perf/bench/seed.ts) on scratch port 4371 and launches the full app through
 * perf/bench/app.ts on the hidden test display (one UI lease per scenario), with the native motion trace on
 * (`KYBERN_MOTION_TRACE=1`, native/patches/motion_trace_gpui.py). Every open is a real pointer click; the trace puts
 * the click, React batches, renders, retained `paintTransform` ticks and presents on one native clock:
 *
 * - `firstPaint`: click → the first present that contains the new popup at all (any opacity);
 * - `firstVisible`: click → the first present in which it is visible (opacity > 0.01). For a `paintTransform`
 *   (the default popup) that is the scope's presented opacity; for the layout tween (`KYBERN_POPUP_MOTION=layout`)
 *   the `motion` opacity sampled by the render before that present;
 * - `renders`: full window renders between the click and the end of the motion; `missing`: retained ticks that fell
 *   back to a render because the scope was not in the presented scene yet.
 *
 * Results append to previews/motion/native/latency.jsonl with the addon hash and env.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { seed } from '../bench/seed.ts'
import { lease } from '../bench/lease.ts'
import { distribution } from '../bench/model.ts'
import { requireScreen } from '../bench/screen-state.ts'
import { waitForWindowOnscreen, requireWindowOnscreen } from '../bench/window-onscreen.ts'
import { launchFixture } from '../../src/requests/harness.ts'

const DATA = '/Users/mymac/projects/ade-gpuix-scratch/motion-native/bench'
const PORT = 4371
const OUT = '/Users/mymac/projects/ade/previews/motion/native'
const root = path.resolve(import.meta.dir, '../..')
const addon = process.env.MOTION_ADDON ?? path.join(root, 'native/build/gpuix-native.darwin-arm64.node')

const argv = process.argv.slice(2)
const flag = (name: string) => { const i = argv.indexOf(name); if (i < 0) return undefined; const v = argv[i + 1]; argv.splice(i, 2); return v }
const extraEnv: Record<string, string> = {}
for (let i = argv.indexOf('--env'); i >= 0; i = argv.indexOf('--env')) { const [k, ...v] = argv[i + 1]!.split('='); extraEnv[k!] = v.join('='); argv.splice(i, 2) }
const opens = Number(flag('--opens') ?? 12)
const keep = argv.includes('--keep-data'); if (keep) argv.splice(argv.indexOf('--keep-data'), 1)
const [label, ...scenarios] = argv
if (!label || !scenarios.length) throw Error('usage: latency.ts <label> <scenario...>')
mkdirSync(OUT, { recursive: true })

const buildMarkers = () => readdirSync('/tmp').filter(n => n.startsWith('kybern-gpuix-native-build.'))
const foreignApps = (pid: number) => Bun.spawnSync(['pgrep', '-fl', 'bun .*/apps/gpuix/']).stdout.toString().split('\n').filter(l => l.trim() && !l.startsWith(`${pid} `) && !l.includes('motion-native/latency.ts'))
const sha = createHash('sha256').update(readFileSync(addon)).digest('hex').slice(0, 16)
const delay = (ms: number) => Bun.sleep(ms)
type Launch = Awaited<ReturnType<typeof launchFixture>>
type Event = { t: number; kind: string; values: Map<string, number>; missing?: string[] }

async function until<T>(check: () => Promise<T | false | null | undefined>, message: string, timeout = 30000): Promise<T> {
  const end = performance.now() + timeout
  for (;;) { const v = await check(); if (v) return v; if (performance.now() > end) throw Error(message); await delay(30) }
}
async function bounds(app: Launch['app'], id: string) {
  return until(async () => { try { for (const { bounds: b } of await app.getByTestId(id).all()) { if (b && b.width > 0 && b.height > 0 && b.x >= 0 && b.y >= 0) return b } return false } catch { return false } }, `No bounds: ${id}`)
}

/** `[mtrace] <ms> <kind> id:value …` (motion_trace_gpui.py / motion_trace_hooks.py / subtree_transform.rs). */
function parse(line: string): Event | undefined {
  const m = /\[mtrace\] ([\d.]+) (.*)$/.exec(line)
  if (!m) return undefined
  const words = m[2]!.trim().split(/\s+/)
  let kind = words.shift()!
  if (kind === 'input' || kind === 'ptx-tick') kind += ' ' + (kind === 'input' ? words.shift() : '')
  const values = new Map<string, number>(), missing: string[] = []
  let section = ''
  for (const w of words) {
    if (w.startsWith('found') || w.startsWith('missing')) { section = w.startsWith('found') ? 'found' : 'missing'; const rest = w.slice(section.length); if (!rest) continue; const [id, v] = rest.split(':'); values.set(id!, Number(v)); if (section === 'missing') missing.push(id!); continue }
    const [id, v] = w.split(':'); if (id && v !== undefined) { values.set(id, Number(v)); if (section === 'missing') missing.push(id) }
  }
  return { t: Number(m[1]), kind: kind.trim(), values, missing }
}

/** Popups and entrances, each opened by a click and closed again (Escape), in the 3,000-turn bench thread. */
const SCENES: Record<string, { open: (c: (a: string, b?: object) => Promise<unknown>) => Promise<void>; trigger: string; close: (app: Launch['app']) => Promise<void>; ms: number }> = {
  'model-picker': { open: async c => { await c('idle'); await c('open', { thread: manifest.long3000 }) }, trigger: 'model-picker', close: app => app.getByTestId('app-ready').press('escape'), ms: 250 },
}

const fixture = await seed(DATA, PORT)
const manifest = fixture.manifest

for (const name of scenarios) {
  const scene = SCENES[name]
  if (!scene) throw Error(`Unknown scenario ${name}`)
  const release = await lease()
  let f: Launch | undefined
  const events: Event[] = []
  let remainder = ''
  const row: Record<string, unknown> = { label, scenario: name, at: new Date().toISOString(), addon: sha, env: extraEnv }
  try {
    const client = path.join(DATA, 'client', `${label}-${name}`); mkdirSync(client, { recursive: true })
    const markers0 = buildMarkers(), foreign0 = foreignApps(0)
    f = await launchFixture(path.join(root, 'perf/bench/app.ts'), {
      ...fixture.env, KYBERN_CLIENT_CONFIG_DIR: client, KYBERN_GPUIX_CREDENTIALS_DIR: path.join(client, 'credentials'),
      GPUIX_BACKGROUND: '1', KYBERN_MOTION_TRACE: '1', KYBERN_PACING_IGNORE_PHYSICAL_MOUSE: '1',
      KYBERN_GPUIX_THREAD: '', KYBERN_APPEARANCE: extraEnv.KYBERN_APPEARANCE ?? 'dark', NAPI_RS_NATIVE_LIBRARY_PATH: addon, ...extraEnv,
    }, { stderr: chunk => { const lines = (remainder + chunk).split('\n'); remainder = lines.pop() ?? ''; for (const l of lines) { const e = parse(l); if (e) events.push(e) } } })
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
    await scene.open(control)
    await delay(4000)
    requireScreen(); requireWindowOnscreen(f.pid)
    const b = await bounds(app, scene.trigger)
    const samples: Record<string, unknown>[] = []
    for (let i = 0; i < opens; i++) {
      // Park, then click: a hover change right before the click would be a different workload.
      await app.mouse.move({ x: b.x + b.width / 2, y: b.y + b.height / 2 })
      await delay(300)
      const from = events.length
      await app.mouse.click({ x: b.x + b.width / 2, y: b.y + b.height / 2 })
      await delay(scene.ms + 350)
      const after = events.slice(from)
      const before = events.slice(Math.max(0, from - 400), from)
      const old = new Set(before.flatMap(e => e.kind === 'present' || e.kind === 'motion' ? [...e.values.keys()] : []))
      const down = after.find(e => e.kind === 'input down'), up = after.find(e => e.kind === 'input up')
      const batch = after.find(e => e.kind === 'batch' && up && e.t >= up.t) ?? after.find(e => e.kind === 'batch')
      const input = up && batch && batch.t >= up.t ? up : down
      let motion = new Map<string, number>(), firstPaint: number | undefined, firstVisible: number | undefined, visibleValue: number | undefined
      let presents = 0, renders = 0, missing = 0, firstPaintPresents = 0
      for (const e of after) {
        if (!input || e.t < input.t) continue
        if (e.t > input.t + scene.ms + 300) break
        if (e.kind === 'render') { renders++; motion = new Map() }
        if (e.kind === 'motion') motion = e.values
        if (e.kind === 'ptx-tick') missing += (e.missing ?? []).filter(id => !old.has(id)).length
        if (e.kind !== 'present') continue
        presents++
        const fresh = [...e.values].filter(([id]) => !old.has(id)).concat([...motion].filter(([id]) => !old.has(id)))
        if (fresh.length && firstPaint === undefined) { firstPaint = e.t - input.t; firstPaintPresents = presents }
        const visible = fresh.filter(([, v]) => v > 0.01)
        if (visible.length && firstVisible === undefined) { firstVisible = e.t - input.t; visibleValue = Math.max(...visible.map(([, v]) => v)) }
      }
      if (i % 1 === 0) await scene.close(app)
      await delay(400)
      samples.push({ input: input?.kind, batchAfterInputMs: batch && input ? batch.t - input.t : undefined, firstPaint, firstVisible, visibleValue, firstPaintPresents, renders, missing })
    }
    const pick = (k: string) => samples.map(s => s[k] as number | undefined).filter((v): v is number => typeof v === 'number')
    Object.assign(row, { samples, firstPaint: distribution(pick('firstPaint')), firstVisible: distribution(pick('firstVisible')), batch: distribution(pick('batchAfterInputMs')), renders: distribution(pick('renders')), missing: pick('missing').reduce((a, b) => a + b, 0), unseen: samples.filter(s => s.firstVisible === undefined).length })
    requireScreen(); requireWindowOnscreen(f.pid)
    const markers1 = buildMarkers(), foreign = [...foreign0, ...foreignApps(f.pid)]
    row.valid = !markers0.length && !markers1.length && !foreign.length
    row.buildMarkers = [...markers0, ...markers1]; row.foreign = foreign
  } catch (error) { row.valid = false; row.error = String(error).slice(0, 2000) }
  finally { await f?.close(); release() }
  appendFileSync(path.join(OUT, 'latency.jsonl'), JSON.stringify(row) + '\n')
  const d = (k: string) => { const v = row[k] as { p50?: number; p95?: number; mean?: number } | undefined; return v ? `${v.p50?.toFixed(1)}/${v.p95?.toFixed(1)}` : '-' }
  console.log(`${label} ${name} valid=${row.valid} firstVisible p50/p95=${d('firstVisible')} firstPaint=${d('firstPaint')} batch=${d('batch')} renders=${d('renders')} missing=${row.missing} unseen=${row.unseen}${row.error ? ' ERROR ' + row.error : ''}`)
}
await fixture.close()
if (!keep) fixture.remove()
