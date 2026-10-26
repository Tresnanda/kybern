// Show more and Full screen on visuals (ADE-80). Seed first (`visual.seed.ts`), then:
//   VISUAL_SCRATCH=… KYBERND=… bun src/transcript/visual.expand.verify.ts [dark|light]
// A tall visual that asks (a real Claude turn waits on it) rests clamped at 480. Its answer bar carries Show more,
// which grows the figure in the thread, and Full screen, which moves the live document (tile B still picked) into a
// window-sized dialog with the same answer bar; Escape closes it and the figure keeps the frozen frame. Skip records the
// answer: the receipt keeps both tools. The tall checklist (no question) opens full screen from its caption; X closes.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { SCRATCH, connect, readState } from '../../visual/fixture.ts'
import { captureWindow, launchLive, until } from './live.ts'
import { LAYOUT_PAGE, LAYOUT_SCHEMA } from './visual.pages.ts'

const variant = (process.argv[2] ?? 'dark') as 'dark' | 'light'
const out = process.env.KYBERN_VERIFY_OUTPUT ?? '/Users/mymac/projects/ade/.kybern-artifacts/ade-80'
mkdirSync(out, { recursive: true })
const state = readState()
if (!state) throw Error('Seed the scratch daemon first (visual.seed.ts)')
const client = await connect(state)
const workspace = path.join(SCRATCH, 'workspace')
const notes = Array.from({ length: 22 }, (_, i) => `<p class="muted">Note ${i + 1}: what changes for readers if this layout ships, and what the EXIF panel shows at this width.</p>`).join('')
const page = LAYOUT_PAGE.replace('</div><script>', `</div>${notes}<script>`)
writeFileSync(path.join(workspace, 'args.json'), JSON.stringify({ html: page, title: 'Pick a layout', height: 1400, await_answer: true, answer_schema: LAYOUT_SCHEMA, timeout_seconds: 600 }, null, 1))
const { projects } = await client.call('projects.list', {})
const project = projects.find(p => p.path === workspace)!
const title = `Visual expand ${variant}`
const prompt = 'Read args.json in this folder. Then call the kybern_html_publish tool once (load it with ToolSearch first if it is deferred) with exactly those arguments: html, title, height, await_answer, answer_schema and timeout_seconds, copied verbatim. The call waits for me. When it returns, reply with one short sentence that says its status.'
await client.call('threads.create', { project_id: project.id, provider: { kind: 'claude-code', instance: 'default' }, model: 'haiku', permission_mode: 'full-access', title, message: { parts: [{ type: 'text', text: prompt }] } })

type Box = { x: number; y: number; width: number; height: number }
const centre = (b: Box) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 })
let f = await launchLive({ theme: variant, thread: title })
// The window capture shows the embedded page; without Screen Recording it falls back to GPUI's (no page pixels).
const shot = async (name: string) => {
  const file = `${out}/${name}-${variant}.png`
  try { captureWindow(f.pid, file) } catch { await f.app.screenshot({ path: file.replace('.png', '-gpui.png') }) }
}
const all = (testId: string) => f.app.getByTestId(testId).all() as Promise<{ bounds?: Box }[]>
const boxOf = async (testId: string, i = 0) => (await all(testId))[i]!.bounds!
const count = (testId: string) => f.app.getByTestId(testId).count()
/** Scroll the figure's top near the window's top, so the bar under it clears the composer. */
async function placeFigure(index = 0) {
  // Wheel deltas don't map 1:1 to pixels: learn the direction and ratio from the first step, then converge.
  let ratio = 0
  for (let i = 0; i < 25; i++) {
    const y = (await boxOf('visual-figure', index)).y
    if (y > 50 && y < 140) return
    const want = 90 - y
    const delta = ratio ? Math.max(-1500, Math.min(1500, want / ratio)) : (want > 0 ? 400 : -400)
    await f.app.mouse.wheel({ x: 1100, y: 400 }, 0, delta); await Bun.sleep(450)
    const moved = (await boxOf('visual-figure', index)).y - y
    if (Math.abs(moved) > 2) ratio = moved / delta
  }
  throw Error(`could not place figure ${index}: y=${(await boxOf('visual-figure', index)).y}`)
}
try {
  await until(async () => (await count('visual-answer-bar')) > 0, 'the answer bar (agent publishing and waiting)', 240_000)
  await until(async () => (await count('visual-picture')) > 0, 'the picture', 20_000)
  await Bun.sleep(1200)
  assert.equal(Math.round((await boxOf('visual-figure')).height), 480, 'a tall question rests at 480')
  assert.equal(await count('visual-more-height'), 1, 'the answer bar has Show more')
  assert.equal(await count('visual-full-screen'), 1, 'the answer bar has Full screen')
  await shot('A1-waiting')

  // Show more grows the figure in the thread; Show less clamps it again.
  await f.app.getByTestId('visual-more-height').click(); await Bun.sleep(700)
  const grown = (await boxOf('visual-figure')).height
  assert.ok(grown > 700, `Show more grows it: ${grown}`)
  await shot('A2-show-more')
  await f.app.getByTestId('visual-more-height').click(); await Bun.sleep(700)
  assert.equal(Math.round((await boxOf('visual-figure')).height), 480, 'Show less clamps it again')

  // Live in place with tile B picked, then Full screen: the same document, B still picked, Send enabled.
  // The tiles are the page's top: scroll them into view first.
  await f.app.mouse.wheel({ x: 1100, y: 400 }, 0, 400); await Bun.sleep(600)
  // …and the answer bar above the composer.
  await placeFigure()
  const figure = await boxOf('visual-figure')
  assert.ok(figure.y > 40, `the figure's top is on screen: ${figure.y}`)
  await f.app.mouse.click({ x: figure.x + figure.width / 2, y: figure.y + 50 })
  await until(async () => (await count('visual-ring-live')) > 0, 'live', 15_000)
  await until(async () => { const node = (await f.app.getByTestId('visual-answer-send').all())[0]; return !!node && !JSON.stringify(node).includes('"aria-disabled":true') }, 'a draft enables Send', 8000)
  await Bun.sleep(400)
  await f.app.getByTestId('visual-full-screen').click()
  await until(async () => (await count('visual-viewer-page')) > 0, 'the full-screen viewer', 8000)
  await Bun.sleep(1500)
  await shot('A3-full-screen')
  const viewer = await boxOf('visual-viewer-page')
  assert.ok(viewer.height > 500 && viewer.width > figure.width, `the viewer is larger than the figure: ${viewer.width}×${viewer.height}`)
  assert.equal(await count('visual-answer-bar'), 2, 'the viewer carries the answer bar')
  assert.equal(await count('visual-ring-live'), 0, 'the figure gave the document up')

  // Escape closes it; the figure shows the frame frozen at the hand-off.
  await f.app.getByTestId('visual-viewer').press('escape')
  await until(async () => (await count('visual-viewer')) === 0, 'the viewer closes', 5000)
  await Bun.sleep(800)
  await shot('A4-closed')

  // Skip: the receipt keeps both tools (shown on hover).
  await placeFigure()
  await f.app.getByTestId('visual-answer-skip').click()
  await until(async () => (await count('visual-answer-receipt')) > 0, 'the skipped receipt', 20_000)
  await Bun.sleep(1500)
  await f.app.mouse.move(centre(await boxOf('visual-figure'))); await Bun.sleep(400)
  assert.equal(await count('visual-full-screen'), 1, 'the receipt has Full screen')
  assert.equal(await count('visual-more-height'), 1, 'the receipt has Show more')
  await shot('A5-receipt')
  await f.app.mouse.click(centre(await boxOf('visual-full-screen')))
  await until(async () => (await count('visual-viewer-page')) > 0, 'the viewer from the receipt', 8000)
  await Bun.sleep(1200)
  assert.equal(await count('visual-answer-bar'), 0, 'an answered visual opens without the bar')
  await shot('A6-receipt-full-screen')
  await f.app.mouse.click(centre(await boxOf('visual-viewer-close')))
  await until(async () => (await count('visual-viewer')) === 0, 'X closes the viewer', 5000)
  await f.close()

  // The tall checklist (no question): Full screen from the caption.
  f = await launchLive({ theme: variant, thread: 'Visuals 69' })
  await until(async () => (await count('visual-picture')) >= 2, 'pictures', 20_000)
  await placeFigure(1)
  const checklist = await boxOf('visual-figure', 1)
  await f.app.mouse.move(centre(checklist)); await Bun.sleep(400)
  await f.app.mouse.click(centre(await boxOf('visual-full-screen', 1)))
  await until(async () => (await count('visual-viewer-page')) > 0, 'the checklist viewer', 8000)
  await Bun.sleep(1500)
  await shot('B1-checklist-full-screen')
  await f.app.mouse.click(centre(await boxOf('visual-viewer-close')))
  await until(async () => (await count('visual-viewer')) === 0, 'X closes the checklist viewer', 5000)
  console.log(`PASS ${variant}: clamp, Show more/less on the answer bar, live hand-off to full screen with the bar, Escape, receipt tools, caption Full screen`)
} catch (error) { console.log(f.diagnostics()); throw error } finally { await f.close() }
process.exit(0)
