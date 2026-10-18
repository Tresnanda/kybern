/**
 * GPUIX frame strips for dragging tall and short task cards past each other (paused clock, one
 * screenshot per 16 ms). Desktop pair: kanban10-ghost-tauri.mjs; cases: kanban10-scenarios.mjs.
 *
 *   KYBERN_DATA_DIR=<scratch daemon> [KYBERN_APPEARANCE=light] [KYBERN_REDUCED_MOTION=1] bun scripts/kanban10-ghost.ts [scenario...]
 *
 * Besides the images, `geometry.json` per strip records the source, its slot and the rows at the
 * hold frame, and the run fails if the dimmed source is not exactly in its slot (an exposed gap).
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { type App } from '@gpuix/react/automation'
import { connect } from '../visual/fixture.ts'
import { launchFixture } from '../src/requests/harness.ts'
// @ts-expect-error plain JS module shared with the WebKit script
import { SCENARIOS } from './kanban10-scenarios.mjs'

type Scenario = { view: 'board' | 'list'; drag: string; over: string; edge: 'top' | 'bottom' }
const data = process.env.KYBERN_DATA_DIR!
if (!data?.includes('gpuix-scratch')) throw new Error('Scratch daemon required')
const theme = process.env.KYBERN_APPEARANCE ?? 'dark'
const reduced = process.env.KYBERN_REDUCED_MOTION === '1'
const root = process.env.GAP_OUT ?? `/Users/mymac/projects/ade/previews/gpuix/phase2/kanban10/gpuix-${theme}${reduced ? '-reduced' : ''}`
const all = SCENARIOS as Record<string, Scenario>
const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(all)
const clientDir = path.join(data, 'kanban10-client'), credsDir = path.join(data, 'kanban10-creds')
mkdirSync(clientDir, { recursive: true }); mkdirSync(credsDir, { recursive: true })
const client = await connect({ daemonPid: 0, port: Number(readFileSync(path.join(data, 'daemon.port'), 'utf8').trim()), token: readFileSync(path.join(data, 'daemon.token'), 'utf8').trim(), seeded: true })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const reset = () => { const r = Bun.spawnSync(['bun', 'scripts/kanban10-seed.ts'], { env: { ...process.env, KYBERN_DATA_DIR: data } }); if (r.exitCode) throw new Error(String(r.stderr)) }
type Pt = { x: number; y: number }
const path2 = (a: Pt, b: Pt, n: number) => Array.from({ length: n }, (_, i) => { const u = (i + 1) / n, e = u * u * (3 - 2 * u); return { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e } })

async function start() {
  writeFileSync(path.join(data, 'gpuix-ui.json'), '{}')
  const fixture = await launchFixture(path.resolve('src/main.tsx'), { GPUIX_BACKGROUND: '1', KYBERN_URL: '', KYBERN_DATA_DIR: data, KYBERN_APPEARANCE: theme, KYBERN_CLIENT_CONFIG_DIR: clientDir, KYBERN_GPUIX_CREDENTIALS_DIR: credsDir, ...(reduced ? { KYBERN_REDUCED_MOTION: '1' } : {}), NAPI_RS_NATIVE_LIBRARY_PATH: path.resolve('native/build/gpuix-native.darwin-arm64.node') })
  await fixture.app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
  await sleep(2000)
  return fixture
}
async function open(app: App, view: string) {
  await app.getByTestId('rail-tasks').click(); await sleep(400)
  if (await app.getByTestId('task-back').count()) await app.getByTestId('task-back').click()
  if (await app.getByTestId(`task-view-${view}`).count()) await app.getByTestId(`task-view-${view}`).click()
  await app.getByTestId(view === 'board' ? 'task-board' : 'task-list-viewport').waitFor({ timeoutMs: 5000 }); await sleep(700)
}
const failures: string[] = []
let fixture: Awaited<ReturnType<typeof start>> | null = null, view = ''
for (const name of names) {
  const s = all[name]!
  reset()
  const ids = Object.fromEntries((await client.call('tasks.items.list', {})).tasks.map((t) => [t.title.split(' with ')[0]!, t.id]))
  if (!fixture || view !== s.view) { await fixture?.close(); fixture = await start(); view = s.view }
  const app = fixture.app
  try {
    await open(app, s.view); await sleep(600)
    const id = ids[s.drag]!, overId = ids[s.over]!
    const src = await app.getByTestId(`task-row-${id}`).bounds(), over = await app.getByTestId(`task-row-${overId}`).bounds()
    const from = { x: src.x + src.width / 2, y: src.y + Math.min(20, src.height / 2) }
    const to = { x: over.x + over.width / 2, y: s.edge === 'top' ? over.y + 4 : over.y + over.height - 4 }
    const dir = `${root}/${name}`
    rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true })
    let n = 0
    const shot = async () => { await app.screenshot({ path: `${dir}/${String(n++).padStart(2, '0')}.png` }) }
    type Box = { x: number; y: number; width: number; height: number }
    const rowsNow = async (): Promise<Record<string, Box | null>> => Object.fromEntries(await Promise.all(Object.entries(ids).map(async ([title, tid]) => [title, (await app.getByTestId(`task-row-${tid}`).count()) ? await app.getByTestId(`task-row-${tid}`).bounds() : null])))
    const tick = (ms: number) => app.clock.fastForward(ms)
    await app.clock.pause()
    await app.mouse.move(from); await tick(32); await app.mouse.down(from)
    await tick(16); await shot()
    for (const p of path2(from, to, 12)) { await app.mouse.move(p, { pressedButton: 0 }); await tick(16); await shot() }
    for (let i = 0; i < 6; i++) { await tick(16); await shot() }
    // Peek: the pointer slides sideways inside the same card, so the held card uncovers its slot.
    const peek = { x: to.x + 70, y: to.y }
    await app.mouse.move(peek, { pressedButton: 0 })
    for (let i = 0; i < 3; i++) { await tick(16); await shot() }
    for (let i = 0; i < 16; i++) await tick(16)
    const hold = await rowsNow()
    const placeholder = (await app.getByTestId('task-drop-placeholder').count()) ? await app.getByTestId('task-drop-placeholder').bounds() : null
    await app.mouse.up(peek)
    for (let i = 0; i < 16; i++) { await tick(16); await shot() }
    await app.clock.resume()
    const deadline = Date.now() + 4000
    while (await app.getByTestId('task-drag-layer').count()) { if (Date.now() > deadline) throw new Error('Drag did not finish'); await sleep(40) }
    await sleep(300)
    const after = await rowsNow()
    writeFileSync(`${dir}/geometry.json`, JSON.stringify({ scenario: s, from, to, src, over, hold, placeholder, after }, null, 1))
    // While held, every card (the dimmed source included, or its placeholder in another column)
    // is painted where the drop lays it out: no exposed source, no empty room. Up to 2 pt: under the
    // paused clock, frames come from screenshots, and a tween retargeted just before the hold can keep
    // its last screenshot-driven step (1.5 pt seen, on the base too). kanban10-ghost-nsevent.ts checks
    // the running display clock exactly.
    const wrong = Object.entries(after).flatMap(([title, a]) => {
      const h = title === s.drag && placeholder ? placeholder : hold[title]
      return a && h && (Math.abs(a.x - h.x) > 2 || Math.abs(a.y - h.y) > 2 || Math.abs(a.height - h.height) > 2) ? [`${title}: held ${h.x},${h.y} h${h.height} lands ${a.x},${a.y} h${a.height}`] : []
    })
    if (wrong.length) throw new Error(`held layout differs from the drop: ${wrong.join('; ')}`)
    console.log('done', name, placeholder ? '(placeholder)' : '')
  } catch (e) { mkdirSync(root, { recursive: true }); await app.screenshot({ path: `${root}/${name}-failed.png` }).catch(() => {}); failures.push(name); console.log('FAILED', name, e instanceof Error ? e.message : e) }
}
await fixture?.close()
reset()
client.close?.()
process.exit(failures.length ? 1 : 0)
