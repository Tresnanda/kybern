/** Tree-connector evidence (lane tree): settled screenshots of the sidebar's nested children, the transcript's
 * "Worked for" disclosure and the dock Agents tree, then paused-clock frame strips of expand, collapse and a
 * child arriving. Visual only: never use these windows for timing.
 *   bun native/ui-lease.ts tree bun perf/tree/shots.ts <label> [--theme dark|light] [--reduced 0|1] [--strips] [--keep]
 */
import '../../src/native/local-build.ts'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../../src/requests/harness.ts'
import { waitForWindowOnscreen } from '../bench/window-onscreen.ts'
import { DATA, PORT, seedTree, uuid } from './seed.ts'

const argv = process.argv.slice(2)
const arg = (name: string, fallback: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1]! : fallback)
const label = argv[0] ?? 'local', theme = arg('--theme', 'dark'), reduced = arg('--reduced', '0')
const strips = argv.includes('--strips')
const root = path.resolve(import.meta.dir, '../..')
const addon = path.join(root, 'native/build/gpuix-native.darwin-arm64.node')
const OUT = path.join('/Users/mymac/projects/ade/previews/tree', `${label}-${theme}${reduced === '1' ? '-reduced' : ''}`)
mkdirSync(OUT, { recursive: true })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const grid = path.join(root, 'scripts/render9-grid.swift')

const fixture = await seedTree(DATA, PORT)
const client = path.join(DATA, 'client', `shots-${label}-${theme}`); mkdirSync(client, { recursive: true })
const f = await launchFixture(path.join(import.meta.dir, 'app.ts'), {
  ...fixture.env, KYBERN_CLIENT_CONFIG_DIR: client, KYBERN_GPUIX_CREDENTIALS_DIR: path.join(client, 'credentials'),
  KYBERN_BENCH_WHEEL_LIBRARY: path.join(DATA, 'bench-wheel.dylib'), KYBERN_GPUIX_THREAD: '', KYBERN_GPUIX_ENVIRONMENT: 'local',
  GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: theme, KYBERN_REDUCED_MOTION: reduced, KYBERN_OPAQUE: '1', KYBERN_PACING_IGNORE_PHYSICAL_MOUSE: '1',
  NAPI_RS_NATIVE_LIBRARY_PATH: addon, TREE_SIDEBAR: '1', TREE_MANIFEST: path.join(DATA, 'tree-manifest.json'),
})
const app = f.app
const shots: Record<string, string> = {}
async function shot(name: string) { const file = path.join(OUT, `${name}.png`); await app.screenshot({ path: file }); shots[name] = file; return file }
let windowId = 0
/** OS capture of the window (what WindowServer shows): instant even mid-motion, where an automation screenshot waits for the
 *  paused clock's motion to settle. */
function osShot(name: string) {
  windowId ||= Number(/window (\d+) onscreen=true/.exec(execFileSync('swift', [path.join(root, 'perf/bench/window-onscreen.swift'), String(f.pid)], { encoding: 'utf8' }))?.[1])
  const file = path.join(OUT, `${name}.png`)
  execFileSync('screencapture', ['-x', '-o', '-l', String(windowId), file])
  shots[name] = file
  return file
}
async function bounds(id: string) {
  for (let i = 0; i < 200; i++) {
    try { for (const { bounds: b } of await app.getByTestId(id).all()) if (b && b.width > 0 && b.height > 0 && b.x >= 0 && b.y >= 0) return b } catch {}
    await sleep(50)
  }
  throw Error(`No bounds: ${id} ${JSON.stringify(await app.getByTestId(id).all().then(a => a.map(e => e.bounds)).catch(e => String(e)))}`)
}
async function click(id: string) { const b = await bounds(id); await app.mouse.click({ x: b.x + Math.min(b.width / 2, 40), y: b.y + b.height / 2 }) }
const control = async (file: string, action: string, args: object = {}) => {
  const port = JSON.parse(readFileSync(path.join(client, file), 'utf8')).port
  const res = await fetch(`http://127.0.0.1:${port}`, { method: 'POST', body: JSON.stringify({ action, ...args }) })
  const body = await res.json() as { error?: string }; if (!res.ok) throw Error(body.error); return body as Record<string, unknown>
}
/** Pixel crop (2x) of a logical rect, through render9-grid.swift (one tile). */
function crop(name: string, files: string[], rect: { x: number; y: number; width: number; height: number }, cols = files.length) {
  const out = path.join(OUT, `${name}.png`)
  execFileSync('swift', [grid, out, String(Math.round(rect.x * 2)), String(Math.round(rect.y * 2)), String(Math.round(rect.width * 2)), String(Math.round(rect.height * 2)), String(cols), ...files])
  return out
}

const tree = fixture.tree
const lastTurn = uuid('turn:2'), batch = uuid(`${lastTurn}:batch`)
/** Bring the last turn's disclosure near the top of the transcript (the tail shows its answer; opening it grows upward). */
async function frame() {
  for (let i = 0; i < 16; i++) {
    const b = (await app.getByTestId(`worked-${lastTurn}`).all())[0]?.bounds
    if (b && b.y >= 90 && b.y <= 160) return
    const surface = await bounds('transcript-surface')
    await control('bench-control.json', 'wheel-probe', { x: surface.x + surface.width / 2, y: surface.y + surface.height / 2, delta: b ? Math.max(-400, Math.min(400, 120 - b.y)) : 300 })
    await sleep(250)
  }
}
try {
  await bounds('app-ready')
  for (let i = 0; i < 200 && !existsSync(path.join(client, 'tree-control.json')); i++) await sleep(50)
  await waitForWindowOnscreen(f.pid, 60_000)
  await control('bench-control.json', 'open', { thread: tree.parent })
  await bounds(`thread-${tree.parent}`)
  await sleep(1500)
  if (process.env.TREE_DEBUG) console.error(JSON.stringify(await control('tree-control.json', 'testids', { title: 'worked|turn-user|tool-group|children-' })))
  await frame()
  await bounds(`worked-${lastTurn}`)
  await sleep(1200)
  const side = await bounds('thread-list')
  const sidebarRect = { x: side.x, y: side.y, width: side.width, height: Math.min(side.height, 420) }
  await click(`worked-${lastTurn}`); await sleep(500)
  for (const { bounds: b } of await app.getByTestId('tool-group').all()) if (b && b.width > 0 && b.y > 0) { await app.mouse.click({ x: b.x + 40, y: b.y + b.height / 2 }); await sleep(400) }
  await click(`tool-row-${batch}`); await sleep(600)
  await frame(); await sleep(300)
  await app.mouse.move({ x: 4, y: 4 })
  await sleep(400)
  const full = await shot('settled')
  const worked = await bounds(`worked-${lastTurn}`)
  const transcriptRect = { x: worked.x - 16, y: worked.y - 8, width: Math.min(worked.width + 32, 720), height: 560 }
  crop('sidebar', [full], sidebarRect)
  crop('transcript', [full], transcriptRect)
  await control('tree-control.json', 'dock-agents'); await sleep(1500)
  await click(`dock-agent-tree-${tree.children.dock}`); await sleep(800)
  await app.mouse.move({ x: 4, y: 4 }); await sleep(300)
  const dockShot = await shot('dock')
  const dockBox = await bounds('right-dock')
  crop('dock-agents', [dockShot], { x: dockBox.x, y: dockBox.y, width: dockBox.width, height: Math.min(dockBox.height, 560) })
  await control('bench-control.json', 'dock-close'); await sleep(600)

  if (strips) {
    const offsets = [0, 30, 60, 90, 120, 160, 200, 260, 400]
    const strip = async (name: string, act: () => Promise<void>, rect: { x: number; y: number; width: number; height: number }, at = offsets) => {
      await app.clock.pause()
      await act(); await sleep(120)
      const frames: string[] = []
      let now = 0
      for (const o of at) { if (o > now) await app.clock.fastForward(o - now); now = o; await sleep(60); frames.push(osShot(`${name}-${String(o).padStart(3, '0')}`)) }
      await app.clock.resume(); await sleep(300)
      crop(`strip-${name}`, frames, rect, 3)
    }
    const parentRow = await bounds(`thread-${tree.parent}`)
    const sideStrip = { x: side.x, y: parentRow.y - 4, width: side.width, height: 200 }
    await strip('sidebar-collapse', () => click(`children-${tree.parent}`), sideStrip, [0, 20, 40, 60, 90, 120, 160, 220, 300])
    await strip('sidebar-expand', () => click(`children-${tree.parent}`), sideStrip)
    await strip('sidebar-arrive', async () => { await control('tree-control.json', 'add-child', { parent: tree.parent, title: 'Check the elbow moves to the new child' }) }, { ...sideStrip, height: 240 })
    // The transcript keeps its tail in place, so an opening group grows upward: frame its last rows.
    const surface = await bounds('transcript-surface')
    const workedStrip = { x: surface.x + 90, y: surface.y + surface.height - 760, width: 600, height: 420 }
    await strip('worked-collapse', () => click(`worked-${lastTurn}`), workedStrip, [0, 20, 40, 60, 90, 120, 160, 220, 300])
    await strip('worked-expand', () => click(`worked-${lastTurn}`), workedStrip)
  }
} finally { await f.close(); if (!argv.includes('--keep')) await fixture.close(); else await fixture.close() }
console.log(JSON.stringify({ out: OUT, shots: Object.keys(shots).length }))
process.exit(0)
