// Bounded, scratch-only resource and geometry-delivery sample. No model turns.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../src/requests/harness.ts'
import { connect } from '../visual/fixture.ts'
const exec = promisify(execFile)
const data = process.env.KYBERN_DATA_DIR!
if (!data?.includes('gpuix-scratch')) throw Error('Scratch daemon required')
const out = process.env.DRAG_OUT!
mkdirSync(out, { recursive: true })
const client = await connect({ daemonPid: 0, port: Number(readFileSync(path.join(data, 'daemon.port'), 'utf8')), token: readFileSync(path.join(data, 'daemon.token'), 'utf8').trim(), seeded: true })
let fixture: Awaited<ReturnType<typeof launchFixture>> | undefined
try {
  const task = (await client.call('tasks.items.list', {})).tasks.find(t => t.title === 'Drag task 02')!
  await client.call('tasks.items.update', { id: task.id, status: 'inbox' })
  writeFileSync(path.join(data, 'gpuix-ui.json'), '{}')
  fixture = await launchFixture(path.resolve('src/main.tsx'), { GPUIX_BACKGROUND: '1', KYBERN_DATA_DIR: data, KYBERN_CLIENT_CONFIG_DIR: path.join(data,'sample-client'), KYBERN_GPUIX_CREDENTIALS_DIR: path.join(data,'sample-creds'), KYBERN_APPEARANCE: 'dark', KYBERN_DRAG_PACING: path.join(out,'geometry'), KYBERN_FRAME_TIMES: '1', NAPI_RS_NATIVE_LIBRARY_PATH: process.env.NAPI_RS_NATIVE_LIBRARY_PATH! })
  const { app, pid } = fixture
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 60000 })
  const click = async (id: string) => { const l = app.getByTestId(id); await l.waitFor(); await l.hover(); await app.clock.fastForward(32); await l.click() }
  await click('rail-tasks'); await click('task-view-board'); await app.getByTestId('task-board').waitFor()
  const idle = await exec('bun', ['perf/sample.ts', '15', `GPUIX=${pid}`])
  writeFileSync(path.join(out, 'idle.txt'), idle.stdout)
  const from = await app.getByTestId(`task-drag-${task.id}`).center()
  const target = await app.getByTestId('task-column-todo').bounds()
  await app.mouse.move(from); await app.clock.fastForward(32); await app.mouse.down(from)
  await app.mouse.move({ x: from.x+8, y: from.y }, { pressedButton: 0 })
  await app.getByTestId('task-ghost').waitFor()
  const active = exec('bun', ['perf/sample.ts', '15', `GPUIX=${pid}`])
  const start = performance.now()
  while (performance.now()-start < 15000) {
    const u = (1-Math.cos((performance.now()-start)/700))/2
    await app.mouse.move({ x: from.x+(target.x+target.width/2-from.x)*u, y: from.y+90*u }, { pressedButton: 0 })
    await Bun.sleep(16)
  }
  await app.getByTestId('app-ready').press('escape'); await app.mouse.up(from)
  writeFileSync(path.join(out, 'active.txt'), (await active).stdout)
  const times = fixture.diagnostics().split('\n').filter(l=>l.startsWith('[kybern-frame]')).map(l=>Number(l.split(' ')[1])).filter(Number.isFinite)
  const intervals=times.slice(1).map((t,i)=>t-times[i]!).filter(t=>t<1000).sort((a,b)=>a-b)
  writeFileSync(path.join(out,'native-submissions.json'),JSON.stringify({kind:'native render/submission callbacks, not display presents',frames:times.length,p50:intervals[Math.floor(intervals.length*.5)]??null,p95:intervals[Math.floor(intervals.length*.95)]??null}))
  console.log(idle.stdout, readFileSync(path.join(out,'active.txt'),'utf8'))
} finally { await fixture?.close(); client.close() }
process.exit(0)
