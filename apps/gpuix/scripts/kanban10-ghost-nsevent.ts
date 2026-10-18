/**
 * The tall/short drag cases (kanban10-scenarios.mjs) with real AppKit mouse events and the display clock running:
 * the window floats on screen (kanban10-nsevent-app.ts), the drag is mouseDown → mouseDragged (8 ms apart) → hold,
 * the held window is captured by id, then mouseUp. Fails if any card, the dimmed source (or its placeholder in
 * another column) included, is held anywhere but where the drop lays it out.
 *
 *   KYBERN_DATA_DIR=<scratch daemon> [KYBERN_APPEARANCE=light] [KYBERN_REDUCED_MOTION=1] bun scripts/kanban10-ghost-nsevent.ts [scenario...]
 *
 * Takes the shared UI lock (queue line `kanban10`); evidence goes to previews/gpuix/phase2/kanban10/nsevent-*.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import path from 'node:path'
import { connect } from '../visual/fixture.ts'
import { launchFixture } from '../src/requests/harness.ts'
import { acquirePreviewUiLock } from './preview-ui-lock.ts'
// @ts-expect-error plain JS module shared with the WebKit script
import { SCENARIOS } from './kanban10-scenarios.mjs'

type Scenario = { view: 'board' | 'list'; drag: string; over: string; edge: 'top' | 'bottom' }
type Box = { x: number; y: number; width: number; height: number }
const data = process.env.KYBERN_DATA_DIR!
if (!data?.includes('gpuix-scratch')) throw new Error('Scratch daemon required')
const theme = process.env.KYBERN_APPEARANCE ?? 'dark'
const reduced = process.env.KYBERN_REDUCED_MOTION === '1'
const root = `/Users/mymac/projects/ade/previews/gpuix/phase2/kanban10/nsevent-${theme}${reduced ? '-reduced' : ''}`
const all = SCENARIOS as Record<string, Scenario>
const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(all)
const clientDir = path.join(data, 'kanban10-client'), credsDir = path.join(data, 'kanban10-creds'), plan = path.join(data, 'kanban10-plan.json')
mkdirSync(clientDir, { recursive: true }); mkdirSync(credsDir, { recursive: true }); mkdirSync(root, { recursive: true })
const client = await connect({ daemonPid: 0, port: Number(readFileSync(path.join(data, 'daemon.port'), 'utf8').trim()), token: readFileSync(path.join(data, 'daemon.token'), 'utf8').trim(), seeded: true })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const until = async (fn: () => Promise<boolean> | boolean, ms: number, label: string) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await sleep(30) } throw new Error(`timed out: ${label}`) }
const reset = () => { const r = Bun.spawnSync(['bun', 'scripts/kanban10-seed.ts'], { env: { ...process.env, KYBERN_DATA_DIR: data } }); if (r.exitCode) throw new Error(String(r.stderr)) }
type Pt = { x: number; y: number }
const path2 = (a: Pt, b: Pt, n: number) => Array.from({ length: n }, (_, i) => { const u = (i + 1) / n, e = u * u * (3 - 2 * u); return { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e } })

const QUEUE = '/tmp/kybern-gpuix-ui-queue', NAME = 'kanban10'
const lines = () => (existsSync(QUEUE) ? readFileSync(QUEUE, 'utf8').split('\n').filter(Boolean) : [])
if (!lines().includes(NAME)) appendFileSync(QUEUE, NAME + '\n')
await until(() => lines()[0] === NAME, 20 * 60_000, 'UI queue turn')
let release: (() => void) | undefined
await until(() => { try { release = acquirePreviewUiLock(); return true } catch { return false } }, 5 * 60_000, 'UI lock')
const failures: string[] = []
try {
  let fixture: Awaited<ReturnType<typeof launchFixture>> | null = null, view = ''
  for (const name of names) {
    const s = all[name]!
    reset()
    const ids = Object.fromEntries((await client.call('tasks.items.list', {})).tasks.map((t) => [t.title.split(' with ')[0]!, t.id]))
    if (!fixture || view !== s.view) {
      await fixture?.close()
      writeFileSync(path.join(data, 'gpuix-ui.json'), '{}')
      fixture = await launchFixture(path.resolve('scripts/kanban10-nsevent-app.ts'), { GPUIX_BACKGROUND: '1', KYBERN_URL: '', KYBERN_DATA_DIR: data, KYBERN_APPEARANCE: theme, KYBERN_CLIENT_CONFIG_DIR: clientDir, KYBERN_GPUIX_CREDENTIALS_DIR: credsDir, KYBERN_OPAQUE: '1', KYBERN_WINDOW_SIZE: '1280x820', GAP_PLAN: plan, ...(reduced ? { KYBERN_REDUCED_MOTION: '1' } : {}), NAPI_RS_NATIVE_LIBRARY_PATH: path.resolve('native/build/gpuix-native.darwin-arm64.node') })
      await fixture.app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
      await sleep(1500)
      view = s.view
    }
    const app = fixture.app, pid = fixture.pid
    const play = async (steps: [string, number, number][], gapMs: number) => {
      rmSync(plan + '.done', { force: true }); writeFileSync(plan, JSON.stringify({ steps, gapMs }))
      process.kill(pid, 'SIGUSR1'); await until(() => existsSync(plan + '.done'), 10_000, 'plan played')
    }
    const rowsNow = async (): Promise<Record<string, Box | null>> => Object.fromEntries(await Promise.all(Object.entries(ids).map(async ([title, tid]) => [title, (await app.getByTestId(`task-row-${tid}`).count()) ? await app.getByTestId(`task-row-${tid}`).bounds() : null])))
    const capture = (file: string) => {
      const r = Bun.spawnSync(['swift', path.resolve('src/tasks/round7-window-id.swift'), String(pid)], { stdout: 'pipe' })
      const id = r.stdout.toString().trim().split(/\s+/)[0]
      if (id) Bun.spawnSync(['screencapture', '-x', '-o', '-l', id, file])
    }
    try {
      await app.getByTestId('rail-tasks').click(); await sleep(400)
      if (await app.getByTestId('task-back').count()) await app.getByTestId('task-back').click()
      if (await app.getByTestId(`task-view-${s.view}`).count()) await app.getByTestId(`task-view-${s.view}`).click()
      await app.getByTestId(s.view === 'board' ? 'task-board' : 'task-list-viewport').waitFor({ timeoutMs: 5000 }); await sleep(700)
      const src = await app.getByTestId(`task-row-${ids[s.drag]}`).bounds(), over = await app.getByTestId(`task-row-${ids[s.over]}`).bounds()
      const from = { x: Math.round(src.x + src.width / 2), y: Math.round(src.y + Math.min(20, src.height / 2)) }
      const to = { x: Math.round(over.x + over.width / 2), y: Math.round(s.edge === 'top' ? over.y + 4 : over.y + over.height - 4) }
      // Peek: the pointer ends 70 pt to the side inside the same card, so the held card uncovers the slot's left edge.
      const peek = { x: to.x + 70, y: to.y }
      await play([['move', from.x, from.y], ['down', from.x, from.y], ...path2(from, to, 30).map((p) => ['drag', p.x, p.y] as [string, number, number]), ...path2(to, peek, 6).map((p) => ['drag', p.x, p.y] as [string, number, number])], 8)
      await sleep(500)
      const placeholder = await app.getByTestId('task-drop-placeholder').count() > 0
      capture(`${root}/${name}-hold.png`)
      await play([['up', peek.x, peek.y]], 0)
      await until(async () => !(await app.getByTestId('task-drag-layer').count()), 4000, 'drag finished')
      await sleep(400)
      const after = await rowsNow()
      capture(`${root}/${name}-after.png`)
      // Live paint translations do not reach automation bounds, so the held frame is read from the capture:
      // down one vertical line of the destination (card fill on the board, the key column in the list), every
      // edge after the drop must already be there while held. The list's held row covers its slot (as in the
      // desktop), so that row's band is left out there.
      const dest = after[s.drag]!
      const x = s.view === 'board' ? dest.x + 6 : dest.x + 52
      const boxes = Object.values(after).filter((b): b is Box => !!b && Math.abs(b.x - dest.x) < 1)
      const y0 = Math.min(...boxes.map((b) => b.y)) - 6, y1 = Math.max(...boxes.map((b) => b.y + b.height)) + 6
      const r = Bun.spawnSync(['swift', path.resolve('scripts/kanban10-edges.swift'), `${root}/${name}-hold.png`, `${root}/${name}-after.png`, String(x), String(y0), String(y1)], { stdout: 'pipe', stderr: 'pipe' })
      const out = r.stdout.toString()
      const missing = (out.match(/^missing(.*)$/m)?.[1] ?? '').trim().split(/\s+/).filter(Boolean).map(Number)
        .filter((y) => s.view === 'board' || y < dest.y - 4 || y > dest.y + dest.height + 4)
      writeFileSync(`${root}/${name}.json`, JSON.stringify({ scenario: s, from, to, peek, placeholder, after, line: { x, y0, y1 }, edges: out, missing }, null, 1))
      if (r.exitCode || !out.includes('after')) throw new Error(`edge read failed: ${r.stderr}`)
      if (missing.length) throw new Error(`held frame lacks edges of the drop at y ${missing.join(', ')}`)
      console.log('done', name, placeholder ? '(placeholder)' : '')
    } catch (e) { failures.push(name); console.log('FAILED', name, e instanceof Error ? e.message : e) }
  }
  await fixture?.close()
} finally {
  try { release?.() } catch {}
  writeFileSync(QUEUE, lines().filter((l) => l !== NAME).map((l) => l + '\n').join(''))
  rmSync(plan, { force: true }); rmSync(plan + '.done', { force: true })
  reset()
}
client.close?.()
process.exit(failures.length ? 1 : 0)
