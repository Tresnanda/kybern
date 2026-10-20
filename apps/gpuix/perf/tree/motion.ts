/** Tree-connector motion cost (lane tree), real time, no screenshots or clock control: the "Worked for" disclosure and the
 * sidebar's nested children toggled 8 times each, alternating the committed sources (`--before <commit>`, through
 * TREE_SOURCE) and the working tree. Reports submission intervals inside each motion (first submission + 300 ms), full
 * draws (window re-renders) with their render ms, React commits, and the submissions in the 2 s after the last motion.
 *   bun native/ui-lease.ts tree bun perf/tree/motion.ts --before 262c74f68 [--theme dark]
 */
import '../../src/native/local-build.ts'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../../src/requests/harness.ts'
import { Telemetry } from '../bench/telemetry.ts'
import { distribution } from '../bench/model.ts'
import { waitForWindowOnscreen } from '../bench/window-onscreen.ts'
import { DATA, PORT, seedTree, uuid } from './seed.ts'

const argv = process.argv.slice(2)
const arg = (name: string, fallback: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1]! : fallback)
const only = arg('--only', ''), toggles = Number(arg('--toggles', '8'))
const before = arg('--before', ''), theme = arg('--theme', 'dark'), repeats = Number(arg('--repeats', '1'))
const root = path.resolve(import.meta.dir, '../..')
const addon = path.join(root, 'native/build/gpuix-native.darwin-arm64.node')
const OUT = '/Users/mymac/projects/ade/previews/tree/perf'; mkdirSync(OUT, { recursive: true })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const markers = () => readdirSync('/tmp').filter(n => n.startsWith('kybern-gpuix-native-build.'))
const fixture = await seedTree(DATA, PORT)
const tree = fixture.tree, lastTurn = uuid('turn:2'), batch = uuid(`${lastTurn}:batch`)
const rows: Record<string, unknown>[] = []

async function run(variant: 'before' | 'after', repeat: number) {
  const t = new Telemetry()
  const client = path.join(DATA, 'client', `motion-${variant}-${repeat}`); mkdirSync(client, { recursive: true })
  const f = await launchFixture(path.join(import.meta.dir, 'app.ts'), {
    ...fixture.env, KYBERN_CLIENT_CONFIG_DIR: client, KYBERN_GPUIX_CREDENTIALS_DIR: path.join(client, 'credentials'),
    KYBERN_BENCH_WHEEL_LIBRARY: path.join(DATA, 'bench-wheel.dylib'), KYBERN_GPUIX_THREAD: '', KYBERN_GPUIX_ENVIRONMENT: 'local',
    GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: theme, KYBERN_REDUCED_MOTION: '0', KYBERN_FULL_RATE: '1', KYBERN_FRAME_TIMES: '1', KYBERN_FRAME_COSTS: '1',
    KYBERN_PACING_IGNORE_PHYSICAL_MOUSE: '1', KYBERN_PACING_BASELINE: '0', KYBERN_PACING_RUNNING_ENTRY: '0',
    NAPI_RS_NATIVE_LIBRARY_PATH: addon, TREE_SIDEBAR: '1', TREE_MANIFEST: path.join(DATA, 'tree-manifest.json'), ...(variant === 'before' ? { TREE_SOURCE: before } : {}),
  }, { stderr: t.stderr })
  const app = f.app
  const bounds = async (id: string) => {
    for (let i = 0; i < 200; i++) { try { for (const { bounds: b } of await app.getByTestId(id).all()) if (b && b.width > 0 && b.y >= 0) return b } catch {} await sleep(50) }
    throw Error(`No bounds: ${id}`)
  }
  const click = async (id: string) => { const b = await bounds(id); await app.mouse.click({ x: b.x + Math.min(40, b.width / 2), y: b.y + b.height / 2 }) }
  const control = async (action: string, args: object = {}) => {
    const port = JSON.parse(readFileSync(path.join(client, 'bench-control.json'), 'utf8')).port
    return (await fetch(`http://127.0.0.1:${port}`, { method: 'POST', body: JSON.stringify({ action, ...args }) })).json()
  }
  try {
    await bounds('app-ready')
    for (let i = 0; i < 200 && !existsSync(path.join(client, 'bench-control.json')); i++) await sleep(50)
    await waitForWindowOnscreen(f.pid, 60_000)
    await control('open', { thread: tree.parent })
    await bounds(`thread-${tree.parent}`); await sleep(2500)
    // Bring the header on screen and keep it there for two checks in a row (anchoring can still move it after a wheel).
    const frame = async () => {
      let steady = 0
      for (let i = 0; i < 40 && steady < 2; i++) {
        const b = (await app.getByTestId(`worked-${lastTurn}`).all())[0]?.bounds
        if (b && b.y >= 50 && b.y <= 600) { steady++; await sleep(300); continue }
        steady = 0
        const s = await bounds('transcript-surface')
        if (process.env.TREE_DEBUG) console.error('[frame]', JSON.stringify(b))
        await control('wheel-probe', { x: s.x + s.width / 2, y: s.y + s.height / 2, delta: b ? Math.max(-400, Math.min(400, 160 - b.y)) : 300 })
        await sleep(300)
      }
    }
    await frame()
    // Open the nested groups once, so every toggle of "Worked for" shows three levels.
    await click(`worked-${lastTurn}`); await sleep(500); await frame()
    for (const { bounds: b } of await app.getByTestId('tool-group').all()) if (b && b.width > 0 && b.y > 0) { await app.mouse.click({ x: b.x + 40, y: b.y + b.height / 2 }); await sleep(400) }
    await click(`tool-row-${batch}`); await sleep(500)
    await frame(); await click(`worked-${lastTurn}`); await sleep(800)
    await frame(); await sleep(800)
    const motions: Record<string, { intervals: number[][]; draws: number[]; renderMs: number[]; commits: number[] }> = {}
    const toggle = async (name: string, id: string, ms: number) => {
      const m = motions[name] ??= { intervals: [], draws: [], renderMs: [], commits: [] }
      if (id.startsWith('worked-')) { await frame(); await sleep(300) }
      const target = await bounds(id)
      await app.mouse.move({ x: target.x + Math.min(40, target.width / 2), y: target.y + target.height / 2 }); await sleep(400)
      const mark = t.mark()
      await app.mouse.click({ x: target.x + Math.min(40, target.width / 2), y: target.y + target.height / 2 })
      await sleep(ms + 400)
      const frames = t.submissions.slice(mark.frames).map(s => s.native)
      m.intervals.push(frames.slice(1).map((v, j) => v - frames[j]!).filter((_, j) => frames[j]! - frames[0]! < ms))
      m.draws.push(t.costs.length - mark.costs); m.renderMs.push(...t.costs.slice(mark.costs).map(c => c.render)); m.commits.push(t.commits - mark.commits)
    }
    const m0 = markers()
    for (let i = 0; i < toggles; i++) { await toggle('worked-open', `worked-${lastTurn}`, 300); await toggle('worked-close', `worked-${lastTurn}`, 300) }
    for (let i = 0; i < (only ? 0 : toggles); i++) { await toggle('sidebar-close', `children-${tree.parent}`, 300); await toggle('sidebar-open', `children-${tree.parent}`, 300) }
    await app.mouse.move({ x: 4, y: 4 }); await sleep(1000)
    const idle = t.mark(); await sleep(2000); const idleFrames = t.submissions.length - idle.frames
    const m1 = markers()
    for (const [name, m] of Object.entries(motions)) {
      const all = m.intervals.flat()
      rows.push({ variant, repeat, theme, motion: name, frames: { ...distribution(all), count: all.length, over16_7: all.filter(v => v > 16.7).length, over33: all.filter(v => v > 33).length }, framesPerMotion: m.intervals.map(s => s.length + 1), fullDraws: distribution(m.draws), renderMs: distribution(m.renderMs), reactCommits: distribution(m.commits), idleSubmissions2s: idleFrames, buildMarkers: [...m0, ...m1] })
    }
  } finally { await f.close() }
}
try {
  for (let r = 1; r <= repeats; r++) for (const variant of (only ? [only] : r % 2 ? ['before', 'after'] : ['after', 'before']) as ('before' | 'after')[]) await run(variant, r)
} finally { await fixture.close() }
const file = path.join(OUT, `motion-${theme}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
writeFileSync(file, JSON.stringify(rows, null, 2))
const fmt = (d: { p50?: number; p95?: number; max?: number } | undefined) => d ? `${d.p50?.toFixed(1)}/${d.p95?.toFixed(1)}/${d.max?.toFixed(1)}` : '-'
for (const r of rows as { variant: string; motion: string; frames: { p50: number; p95: number; max: number; count: number; over16_7: number; over33: number }; fullDraws: never; renderMs: never; reactCommits: never; idleSubmissions2s: number }[])
  console.log(`${r.variant.padEnd(6)} ${r.motion.padEnd(13)} intervals p50/p95/max ${fmt(r.frames)} n=${r.frames.count} >16.7=${r.frames.over16_7} >33=${r.frames.over33} | draws ${fmt(r.fullDraws)} | renderMs ${fmt(r.renderMs)} | commits ${fmt(r.reactCommits)} | idle2s=${r.idleSubmissions2s}`)
console.log(file)
process.exit(0)
