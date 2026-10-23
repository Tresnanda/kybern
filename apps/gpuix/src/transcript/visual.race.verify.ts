// A visual made live must show and take clicks, however late its document is created (ADE-69 review: an awaiting
// visual reported ready but stayed blank). Seed first (`visual.seed.ts`), then:
//   VISUAL_SCRATCH=… bun src/transcript/visual.race.verify.ts race [runs] [pause ms, 500; 0 is the control]
//   VISUAL_SCRATCH=… bun src/transcript/visual.race.verify.ts agent [runs]
// race: each run is a fresh app (no web host yet); the scratch daemon is paused (SIGSTOP) across the click, so the
// document's frame ticket, and with it the native host, arrives after the figure's slot was first placed.
// agent: each run is a real Claude turn publishing the layout picker with `await_answer`; tile B, then tile C, are clicked
// and must draft. Both check the live figure's pixels in a window capture (a blank figure is the flat background).
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { SCRATCH, connect, readState } from '../../visual/fixture.ts'
import { ROOT, captureWindow, launchLive, until } from './live.ts'
import { LAYOUT_PAGE, LAYOUT_SCHEMA } from './visual.pages.ts'

const mode = (process.argv[2] ?? 'race') as 'race' | 'agent'
const runs = Number(process.argv[3] ?? 10)
const pause = Number(process.argv[4] ?? 500)
const out = process.env.KYBERN_VERIFY_OUTPUT ?? '/Users/mymac/projects/ade/.kybern-artifacts/ade-69-71/blank-live'
mkdirSync(out, { recursive: true })
const state = readState()
if (!state) throw Error('Seed the scratch daemon first (visual.seed.ts)')
type Box = { x: number; y: number; width: number; height: number }
/** The figure's luma spread in a window capture (2x), inset past the ring. */
function spread(file: string, box: Box) {
  const r = Bun.spawnSync(['swift', path.join(ROOT, 'visual/region-stats.swift'), file, ...[box.x + 4, box.y + 4, box.width - 8, Math.min(box.height, 300) - 8].map(v => String(Math.round(v * 2)))])
  return JSON.parse(r.stdout.toString()) as { mean: number; sd: number }
}
const painted = async (app: { call(method: string, params: object): Promise<unknown> }) => ((await app.call('getPaintedText', {})) as { text: string[] }).text.join(' ')
const results: { run: number; ok: boolean; sd: number; note: string }[] = []

async function race(run: number) {
  const f = await launchLive({ thread: 'Visuals 69' })
  try {
    const app = f.app
    await until(async () => (await app.getByTestId('visual-picture').count()) >= 2, 'pictures', 20_000)
    await app.mouse.wheel({ x: 1100, y: 400 }, 0, 8000); await Bun.sleep(800)
    const figure = (await app.getByTestId('visual-figure').all())[0]!.bounds!
    if (pause) process.kill(state!.daemonPid, 'SIGSTOP')
    try {
      await app.mouse.click({ x: figure.x + 712, y: figure.y + 13 })
      await Bun.sleep(pause)
    } finally { if (pause) process.kill(state!.daemonPid, 'SIGCONT') }
    await until(async () => (await app.getByTestId('visual-live').count()) > 0, 'live', 15_000)
    await Bun.sleep(900)
    const file = `${out}/race-${run}.png`
    captureWindow(f.pid, file)
    const { sd } = spread(file, figure)
    results.push({ run, ok: sd > 6, sd, note: '' })
  } catch (error) { results.push({ run, ok: false, sd: 0, note: String(error) }) } finally { await f.close() }
}

async function agent(run: number) {
  const client = await connect(state!)
  const workspace = path.join(SCRATCH, 'workspace')
  writeFileSync(path.join(workspace, 'args.json'), JSON.stringify({ html: LAYOUT_PAGE, title: 'Pick a layout', height: 420, await_answer: true, answer_schema: LAYOUT_SCHEMA, timeout_seconds: 600 }, null, 1))
  const { projects } = await client.call('projects.list', {})
  const project = projects.find(p => p.path === workspace)!
  const title = `Blank live ${run} ${Date.now()}`
  const prompt = 'Read args.json in this folder. Then call the kybern_html_publish tool once (load it with ToolSearch first if it is deferred) with exactly those arguments: html, title, height, await_answer, answer_schema and timeout_seconds, copied verbatim. The call waits for me. When it returns, reply with one short sentence that says its status and, if answered, the layout.'
  await client.call('threads.create', { project_id: project.id, provider: { kind: 'claude-code', instance: 'default' }, model: 'haiku', permission_mode: 'full-access', title, message: { parts: [{ type: 'text', text: prompt }] } })
  const f = await launchLive({ thread: title })
  try {
    const app = f.app
    await until(async () => (await app.getByTestId('visual-answer-bar').count()) > 0, 'the answer bar', 240_000)
    await until(async () => (await app.getByTestId('visual-picture').count()) > 0, 'the picture', 20_000)
    await Bun.sleep(1200)
    const figure = (await app.getByTestId('visual-figure').all())[0]!.bounds!
    await app.mouse.click({ x: figure.x + figure.width / 2, y: figure.y + 50 })
    await until(async () => (await app.getByTestId('visual-ring-live').count()) > 0, 'live', 10_000)
    const drafted = (layout: string) => until(async () => (await painted(app)).includes(`Layout ${layout}`), `a draft of layout ${layout}`, 6000).then(() => true, () => false)
    const b = await drafted('B')
    await Bun.sleep(500)
    const file = `${out}/agent-${run}.png`
    captureWindow(f.pid, file)
    const { sd } = spread(file, figure)
    // A second click while live: GPUI holds this synthetic pointer, so it is replayed on tile C.
    await app.mouse.click({ x: figure.x + figure.width * 5 / 6, y: figure.y + 50 })
    const c = await drafted('C')
    await app.getByTestId('visual-answer-skip').click().catch(() => {})
    results.push({ run, ok: sd > 6 && b && c, sd, note: `draft B ${b}, draft C ${c}` })
  } catch (error) { results.push({ run, ok: false, sd: 0, note: String(error) }) } finally { await f.close(); client.close?.() }
}

for (let run = 1; run <= runs; run++) {
  await (mode === 'race' ? race(run) : agent(run))
  console.log(JSON.stringify(results.at(-1)))
}
const passed = results.filter(r => r.ok).length
console.log(`${mode}: ${passed}/${runs} live figures visible${mode === 'agent' ? ' and drafting' : ''}`)
writeFileSync(`${out}/${mode}-results.json`, JSON.stringify(results, null, 1))
assert.equal(passed, runs)
process.exit(0)
