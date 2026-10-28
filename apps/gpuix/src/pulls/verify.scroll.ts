/** Scrolling the Summary of a long description with the sidebar beside it: render/layout cost per scroll frame and frame pacing. */
import path from 'node:path'
import { launchFixture } from '../requests/harness.ts'
import { actionFixture } from './verify.fixture.ts'

const fixture = actionFixture({ state: (process.argv[2] as never) || 'running', long: true })
const f = await launchFixture(path.join(import.meta.dir, '../main.tsx'), { ...fixture.env, KYBERN_APPEARANCE: 'dark', KYBERN_WINDOW_SIZE: '1440x900', KYBERN_FRAME_COSTS: '1', KYBERN_FRAME_TIMES: '1' })
const a = f.app
const pct = (v: number[], q: number) => [...v].sort((x, y) => x - y)[Math.min(v.length - 1, Math.floor(v.length * q))] ?? 0
try {
  await a.getByTestId('app-ready').waitFor({ timeoutMs: 60000 })
  await a.getByTestId('rail-pulls').click(); await Bun.sleep(350)
  await a.getByTestId('pr-row-108').click(); await a.getByTestId('pr-summary').waitFor(); await Bun.sleep(1500)
  const area = await a.getByTestId('pr-detail').bounds()
  const mark = f.diagnostics().length
  const frames0 = f.frameTimes().length
  for (let i = 0; i < 240; i++) { await a.mouse.wheel({ x: area.x + 300, y: area.y + 400 }, 0, i < 120 ? -40 : 40); await Bun.sleep(8) }
  await Bun.sleep(600)
  const log = f.diagnostics().slice(mark)
  const work = [...log.matchAll(/\[kybern-work\] renderMs=([\d.]+) layoutMs=([\d.]+) layoutCalls=(\d+)/g)].map(m => ({ render: +m[1], layout: +m[2], calls: +m[3] }))
  const hits = [...log.matchAll(/\[scroll-layout-frame\] hits=(\d+) nodes=(\d+)/g)].map(m => +m[1])
  const ft = f.frameTimes().slice(frames0)
  console.log(JSON.stringify({ islands: process.env.KYBERN_SCROLL_ISLANDS ?? 'default', frames: ft.length, workFrames: work.length, renderP50: pct(work.map(w => w.render), .5), renderP95: pct(work.map(w => w.render), .95), layoutP50: pct(work.map(w => w.layout), .5), layoutP95: pct(work.map(w => w.layout), .95), layoutCallsP50: pct(work.map(w => w.calls), .5), layoutCallsP95: pct(work.map(w => w.calls), .95), cacheHitsMax: Math.max(0, ...hits) }))
} finally { await f.close(); fixture.close() }
