// Visuals that talk back (ADE-69 V1), against a real agent turn: a Claude turn in the scratch daemon publishes the layout
// picker with `await_answer` and waits. Seed first (`visual.seed.ts`), then:
//   VISUAL_SCRATCH=… bun src/transcript/visual.answer.verify.ts answer|skip|reply [dark|light|glass]
// answer: click tile B in the picture (live, replayed), the bar offers "Send layout B", send it, the receipt and the
// locked picture follow. skip: Skip. reply: type in the composer ("Or reply in your own words") and send.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { SCRATCH, connect, readState } from '../../visual/fixture.ts'
import { captureWindow, launchLive, until } from './live.ts'
import { LAYOUT_PAGE, LAYOUT_SCHEMA } from './visual.pages.ts'

const mode = (process.argv[2] ?? 'answer') as 'answer' | 'skip' | 'reply'
const variant = (process.argv[3] ?? 'dark') as 'dark' | 'light' | 'glass'
const out = process.env.KYBERN_VERIFY_OUTPUT ?? '/Users/mymac/projects/ade/.kybern-artifacts/ade-69-71/L-visual'
mkdirSync(out, { recursive: true })
const state = readState()
if (!state) throw Error('Seed the scratch daemon first (visual.seed.ts)')
const client = await connect(state)
const workspace = path.join(SCRATCH, 'workspace')
writeFileSync(path.join(workspace, 'args.json'), JSON.stringify({ html: LAYOUT_PAGE, title: 'Pick a layout', height: 420, await_answer: true, answer_schema: LAYOUT_SCHEMA, timeout_seconds: 600 }, null, 1))
const { projects } = await client.call('projects.list', {})
const project = projects.find(p => p.path === workspace)!
const title = `Visual ask ${mode} ${variant}`
const prompt = 'Read args.json in this folder. Then call the kybern_html_publish tool once (load it with ToolSearch first if it is deferred) with exactly those arguments: html, title, height, await_answer, answer_schema and timeout_seconds, copied verbatim. The call waits for me. When it returns, reply with one short sentence that says its status and, if answered, the layout.'
await client.call('threads.create', { project_id: project.id, provider: { kind: 'claude-code', instance: 'default' }, model: 'haiku', permission_mode: 'full-access', title, message: { parts: [{ type: 'text', text: prompt }] } })

const f = await launchLive({ theme: variant === 'light' ? 'light' : 'dark', thread: title, env: variant === 'glass' ? { KYBERN_OPAQUE: '0', KYBERN_WINDOW_MATERIAL: 'window' } : {} })
const shot = (name: string) => captureWindow(f.pid, `${out}/${name}-${variant}.png`)
const boxOf = async (testId: string) => (await f.app.getByTestId(testId).all())[0]!.bounds!
try {
  const app = f.app
  await until(async () => (await app.getByTestId('visual-answer-bar').count()) > 0, 'the answer bar (agent publishing and waiting)', 240_000)
  await until(async () => (await app.getByTestId('visual-picture').count()) > 0, 'the picture', 20_000)
  await Bun.sleep(1200)
  shot(`T1-waiting-${mode}`)
  if (mode === 'answer') {
    // Tile B is the middle third of the grid.
    const figure = await boxOf('visual-figure')
    await app.mouse.click({ x: figure.x + figure.width / 2, y: figure.y + 50 })
    await until(async () => (await app.getByTestId('visual-ring-live').count()) > 0, 'live', 10_000)
    await until(async () => { const node = (await app.getByTestId('visual-answer-send').all())[0]; return !!node && !JSON.stringify(node).includes('"aria-disabled":true') }, 'a draft enables Send', 8000)
    await Bun.sleep(400)
    shot('T2-selected')
    await app.getByTestId('visual-answer-send').click()
    await until(async () => (await app.getByTestId('visual-answer-receipt').count()) > 0, 'the receipt', 20_000)
    await Bun.sleep(2500)
    shot('T4-answered')
  } else if (mode === 'skip') {
    await app.getByTestId('visual-answer-skip').click()
    await until(async () => (await app.getByTestId('visual-answer-receipt').count()) > 0, 'the skipped receipt', 20_000)
    await Bun.sleep(1500)
    shot('T-skipped')
  } else {
    await app.getByTestId('composer').fill('B, but put the EXIF panel on the left.')
    await Bun.sleep(300)
    shot('T5-typing-instead')
    await app.getByTestId('composer').press('enter')
    await until(async () => (await app.getByTestId('visual-answer-receipt').count()) > 0, 'the replied receipt', 20_000)
    await Bun.sleep(1500)
    shot('T6-replied')
  }
  const { transcript } = await client.call('threads.get', { thread_id: f.thread!.id }) as { transcript: { role: string; answer?: { status: string } }[] }
  const visual = transcript.find(e => e.role === 'visual')
  console.log(`PASS ${mode} ${variant}: ${JSON.stringify(visual?.answer)}`)
  assert.ok(visual?.answer, 'the receipt is in the projected transcript')
} catch (error) { console.log(f.diagnostics()); throw error } finally { await f.close(); client.close?.() }
process.exit(0)
