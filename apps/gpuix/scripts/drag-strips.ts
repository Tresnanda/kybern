/**
 * Scripted drags against the scratch daemon: a frame strip per interaction (paused clock, one
 * screenshot per ~16 ms of animation time) and a real-time pacing run.
 *
 *   KYBERN_DATA_DIR=<gpuix-scratch daemon> bun scripts/drag-strips.ts <label> [tasks-board tasks-list split projects]
 *
 * Output: /Users/mymac/projects/ade/previews/gpuix/drag/<label>/<scenario>/NN.png and
 * <scenario>-pacing/*.json (see src/drag/pacing.ts).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { type App } from '@gpuix/react/automation'
import { connect } from '../visual/fixture.ts'
import { launchFixture } from '../src/requests/harness.ts'

const data = process.env.KYBERN_DATA_DIR!
if (!data?.includes('gpuix-scratch')) throw new Error('Scratch daemon required')
const [label = 'before', ...rest] = process.argv.slice(2)
const scenarios = rest.length ? rest : ['tasks-board', 'tasks-list', 'split', 'projects', 'dock-tabs']
const root = process.env.DRAG_OUT ?? `/Users/mymac/projects/ade/previews/gpuix/drag/${label}`
const theme = process.env.KYBERN_APPEARANCE ?? 'dark'
const clientDir = path.join(data, 'tasks3-drag-client')
const credsDir = path.join(data, 'tasks3-drag-creds')
mkdirSync(clientDir, { recursive: true }); mkdirSync(credsDir, { recursive: true })
const client = await connect({ daemonPid: 0, port: Number(readFileSync(path.join(data, 'daemon.port'), 'utf8').trim()), token: readFileSync(path.join(data, 'daemon.token'), 'utf8').trim(), seeded: true })
const S = ['inbox', 'todo', 'done', 'canceled'] as const
// Drops move tasks: put every fixture back where drag-seed.ts created it, so each run starts from the same board.
const all = (await client.call('tasks.items.list', {})).tasks.filter((t) => t.title.startsWith('Drag task'))
for (const t of all) {
  const i = Number(t.title.slice(-2)) - 1
  const status = S[i < 8 ? 0 : i < 16 ? 1 : i < 22 ? 2 : 3]
  if (t.status !== status) await client.call('tasks.items.update', { id: t.id, status, before_id: null }).catch(() => {})
}
const tasks = (await client.call('tasks.items.list', {})).tasks.filter((t) => t.title.startsWith('Drag task'))
const threads = (await client.call('threads.list', {})).threads
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const fixtures = new WeakMap<App, Awaited<ReturnType<typeof launchFixture>>>()
async function start(pacing?: string) {
  writeFileSync(path.join(data, 'gpuix-ui.json'), '{}') // persisted filters / split layouts from other checks would hide the fixtures
  const fixture = await launchFixture(path.resolve('src/main.tsx'), { ...(process.env.DRAG_FG ? {} : { GPUIX_BACKGROUND: '1' }), KYBERN_DATA_DIR: data, KYBERN_APPEARANCE: theme, KYBERN_CLIENT_CONFIG_DIR: clientDir, KYBERN_GPUIX_CREDENTIALS_DIR: credsDir, ...(process.env.KYBERN_REDUCED_MOTION ? { KYBERN_REDUCED_MOTION: process.env.KYBERN_REDUCED_MOTION } : {}), NAPI_RS_NATIVE_LIBRARY_PATH: process.env.NAPI_RS_NATIVE_LIBRARY_PATH!, ...(pacing ? { KYBERN_DRAG_PACING: pacing } : {}), ...(process.env.KYBERN_FRAME_TIMES ? { KYBERN_FRAME_TIMES:process.env.KYBERN_FRAME_TIMES } : {}) })
  const app = fixture.app
  fixtures.set(app, fixture)
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
  await sleep(2500)
  return app
}
type Pt = { x: number; y: number }
/** A smooth path of `n` points with ease-in-out, ending with a slow settle. */
const path2 = (a: Pt, b: Pt, n: number) => Array.from({ length: n }, (_, i) => { const u = (i + 1) / n, e = u * u * (3 - 2 * u); return { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e } })

type Plan = { app: App; from: Pt; to: Pt; hold?: number; source?: { x:number; y:number; width:number; height:number } }
async function strip(plan: Plan, dir: string, cancel = false) {
  mkdirSync(dir, { recursive: true })
  const { app, from, to } = plan
  await app.clock.pause()
  let n = 0
  const selected = process.env.DRAG_CAPTURE_FRAMES?.split(',').map(Number)
  const shot = async () => { const frame = n++; if (!selected || selected.includes(frame)) await app.screenshot({ path: `${dir}/${String(frame).padStart(2, '0')}.png` }) }
  await app.mouse.move(from); await app.clock.fastForward(32); await app.mouse.down(from)
  await app.clock.fastForward(16); await shot() // press
  for (const [i, p] of path2(from, to, 12).entries()) { await app.mouse.move(p, { pressedButton: 0 }); await app.clock.fastForward(16); if (i === 3) { await app.getByTestId(layerFor()).waitFor({ timeoutMs: 3000 }); if (activeScenario.startsWith('tasks')) { await app.getByTestId('task-ghost').waitFor({ timeoutMs: 3000 }); const ghost = await app.getByTestId('task-drag-ghost').bounds(); writeFileSync(`${dir}/ghost.json`, JSON.stringify({ pointer: p, grab: plan.source && {x:from.x-plan.source.x,y:from.y-plan.source.y}, ghost, layer: await app.getByTestId('task-drag-layer').bounds() })); } } await shot() }
  for (let i = 0; i < 6; i++) { await app.clock.fastForward(16); await shot() } // hold over target
  if (cancel) await app.getByTestId('app-ready').press('escape')
  else await app.mouse.up(to)
  for (let i = 0; i < 16; i++) { await app.clock.fastForward(16); await shot() } // drop / settle
  if (cancel) await app.mouse.up(to)
  await app.clock.resume()
}
async function realtime(plan: Plan) {
  const { app, from, to } = plan
  await app.mouse.move(from); await app.clock.fastForward(32); await app.mouse.down(from)
  for (const p of path2(from, to, 90)) { await app.mouse.move(p, { pressedButton: 0 }); await sleep(8) }
  await app.getByTestId(layerFor()).waitFor({ timeoutMs:3000 })
  if (plan.source) {
    const expected = {x:to.x-(from.x-plan.source.x), y:to.y-(from.y-plan.source.y)}
    const end=Date.now()+3000
    let actual=await app.getByTestId('task-drag-ghost').bounds()
    while (Math.abs(actual.x-expected.x)>1 || Math.abs(actual.y-expected.y)>1) {
      if(Date.now()>end)throw Error(`Ghost lost grab offset: ${JSON.stringify({expected,actual})}`)
      await sleep(20);actual=await app.getByTestId('task-drag-ghost').bounds()
    }
    mkdirSync(root,{recursive:true});writeFileSync(`${root}/${activeScenario}-offset.json`,JSON.stringify({expected,actual}))
  }
  await sleep(150)
  await app.mouse.up(to)
  const deadline = Date.now()+4000
  while (await app.getByTestId(layerFor()).count()) { if (Date.now()>deadline) throw Error('Drag did not finish after release'); await sleep(40) }
  if (activeScenario==='tasks-board') {
    const moved=await client.call('tasks.items.get',{id:pick('inbox',1).id})
    if(moved.task?.status!=='todo')throw Error('Board drop did not move the task to Todo')
  }
}

const pick = (status: string, n = 0) => tasks.filter((t) => t.status === status)[n]!
const scenariosImpl: Record<string, (app: App) => Promise<Plan>> = {
  async 'tasks-board'(app) {
    await app.getByTestId('rail-tasks').click(); await sleep(500)
    if (await app.getByTestId('task-back').count()) await app.getByTestId('task-back').click()
    await app.getByTestId('task-view-board').click(); await sleep(500)
    const a = await app.getByTestId(`task-drag-${pick('inbox', 1).id}`).center()
    const col = await app.getByTestId('task-column-todo').bounds()
    return { app, from: a, to: { x: col.x + col.width / 2, y: col.y + 150 }, source: await app.getByTestId(`task-slot-${pick('inbox', 1).id}`).bounds() }
  },
  async 'tasks-list'(app) {
    await app.getByTestId('rail-tasks').click(); await sleep(500)
    if (await app.getByTestId('task-back').count()) await app.getByTestId('task-back').click()
    await app.getByTestId('task-view-list').click(); await sleep(500)
    const a = await app.getByTestId(`task-drag-${pick('inbox', 1).id}`).center()
    return { app, from: a, to: { x: a.x, y: a.y + 200 }, source: await app.getByTestId(`task-slot-${pick('inbox', 1).id}`).bounds() }
  },
  async split(app) {
    const open = threads.find((t) => t.title?.startsWith('alpha-app thread 1'))!
    const drag = threads.find((t) => t.title?.startsWith('alpha-app thread 2'))!
    await app.getByTestId(`thread-${open.id}`).click(); await sleep(1200)
    const a = await app.getByTestId(`thread-${drag.id}`).center()
    return { app, from: a, to: { x: 1100, y: 420 } }
  },
  async 'dock-tabs'(app) {
    const open = threads.find((t) => t.title?.startsWith('alpha-app thread 1'))!
    await app.getByTestId(`thread-${open.id}`).click(); await sleep(1200)
    if (!(await app.getByTestId('dock-tabs').count())) { await app.getByTestId('dock-toggle').click(); await sleep(600) }
    for (const id of ['terminal', 'notes', 'tasks']) {
      if (await app.getByTestId(`dock-tab-${id}`).count()) continue
      await app.getByTestId('dock-add').click(); await sleep(250)
      await app.getByTestId(`dock-add-${id}`).click(); await sleep(400)
    }
    const a = await app.getByTestId('dock-tab-terminal').center()
    const b = await app.getByTestId('dock-tab-tasks').bounds()
    return { app, from: a, to: { x: b.x + b.width - 20, y: a.y } }
  },
  async projects(app) {
    const names = ['alpha-app', 'beta-docs']
    const projects = (await client.call('projects.list', {})).projects.filter((p) => names.includes(p.name))
    const a = await app.getByTestId(`project-${projects.find((p) => p.name === 'alpha-app')!.id}`).center()
    const b = await app.getByTestId(`project-${projects.find((p) => p.name === 'beta-docs')!.id}`).bounds()
    return { app, from: a, to: { x: a.x, y: b.y + b.height + 30 } }
  },
}
const failures:string[] = []
let activeScenario = ''
const layerFor = () => activeScenario.startsWith('tasks') ? 'task-drag-layer' : activeScenario === 'projects' ? 'project-drag-layer' : activeScenario === 'dock-tabs' ? 'dock-tab-drag-layer' : 'split-drag-layer'
for (const name of scenarios) {
  activeScenario = name
  for (const mode of (process.env.DRAG_MODES?.split(',') ?? ['strip', 'pacing']) as ('strip' | 'pacing')[]) {
    const app = await start(mode === 'pacing' ? `${root}/${name}-pacing` : undefined)
    try {
      const plan = await scenariosImpl[name]!(app)
      if (mode === 'strip') { await strip(plan, `${root}/${name}`); await sleep(200); await strip(await scenariosImpl[name]!(app), `${root}/${name}-cancel`, true) }
      else {
        const prior = fixtures.get(app)!.diagnostics().split('\n').filter(l => l.startsWith('[kybern-frame]')).map(l => Number(l.split(' ')[1])).filter(Number.isFinite).at(-1) ?? -Infinity
        await realtime(plan)
        const frames = fixtures.get(app)!.diagnostics().split('\n').filter(l => l.startsWith('[kybern-frame]')).map(l => Number(l.split(' ')[1])).filter(t => Number.isFinite(t) && t > prior)
        const intervals = frames.slice(1).map((t,i) => t-frames[i]!).filter(v => v > 0 && v < 1000).sort((a,b) => a-b)
        mkdirSync(root, {recursive:true})
        const summary = { kind:'native render/submission callbacks; not display presents', frames:frames.length, times:frames, p50:intervals[Math.floor(intervals.length*.5)]??null, p95:intervals[Math.floor(intervals.length*.95)]??null }
        writeFileSync(`${root}/${name}-native-submissions.json`, JSON.stringify(summary))
        console.log(name, JSON.stringify({...summary, times:undefined}))
      }
      console.log('done', name, mode)
    } catch (e) { failures.push(`${name}:${mode}`); console.log('FAILED', name, mode, e instanceof Error ? e.message : e) } finally { await fixtures.get(app)!.close() }
  }
}
client.close?.()
process.exit(failures.length ? 1 : 0)
