// Inline visuals, A′ (ADE-69). Seed first (`visual.seed.ts`), then:
//   VISUAL_SCRATCH=… bun src/transcript/visual.verify.ts [dark|light|glass]
// Rest is a picture (no web process); hovering the page's Raw toggle washes it; clicking it makes the document live in
// place and the click reaches the toggle; Esc freezes it back into a picture that shows Raw; Open in a tab moves the
// same document (Raw still selected); the tall checklist rests clamped and Show more grows it. The embedded document
// is captured with `screencapture -l` (the GPUI screenshot API omits child NSViews); the pointer is GPUI-level.
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { captureWindow, launchLive, until } from './live.ts'

const out = process.env.KYBERN_VERIFY_OUTPUT ?? '/Users/mymac/projects/ade/.kybern-artifacts/ade-69-71/L-visual'
mkdirSync(out, { recursive: true })
const variant = (process.argv[2] ?? 'dark') as 'dark' | 'light' | 'glass'
const webContents = () => Bun.spawnSync(['pgrep', '-f', 'com.apple.WebKit.WebContent']).stdout.toString().split('\n').filter(Boolean).length
const baseline = webContents()
const f = await launchLive({ theme: variant === 'light' ? 'light' : 'dark', thread: 'Visuals 69', env: variant === 'glass' ? { KYBERN_OPAQUE: '0', KYBERN_WINDOW_MATERIAL: 'window' } : {} })
/** The i-th match's painted bounds. */
const boxOf = async (locator: { all(): Promise<{ bounds?: { x: number; y: number; width: number; height: number } }[]> }, i: number) => (await locator.all())[i]!.bounds!
const centre = (b: { x: number; y: number; width: number; height: number }) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 })
const shot = (name: string) => captureWindow(f.pid, `${out}/${name}-${variant}.png`)
try {
  const app = f.app
  await until(async () => (await app.getByTestId('visual-picture').count()) >= 2, 'pictures', 20000)
  const figures = app.getByTestId('visual-figure')
  // The bundle chart is the first visual: scroll it into view.
  await app.mouse.wheel({ x: 1100, y: 400 }, 0, 8000); await Bun.sleep(800)
  const figure = await boxOf(figures, 0)
  assert.equal(webContents(), baseline, 'pictures at rest start no web process')
  await app.mouse.move({ x: 20, y: 790 }); await Bun.sleep(300)
  shot('1-rest')

  // Hover the Raw toggle: the hit map washes it; the caption actions fade in.
  const raw = { x: figure.x + 712, y: figure.y + 13 }
  await app.mouse.move(raw); await Bun.sleep(400)
  await until(async () => (await app.getByTestId('visual-hit').count()) === 1, 'hit-map wash')
  shot('2-hover')

  // Click it: live in place, the click is replayed on the toggle.
  await app.mouse.click(raw)
  await until(async () => (await app.getByTestId('visual-live').count()) > 0, 'live', 15000)
  await Bun.sleep(600)
  shot('3-live')
  const live = await boxOf(figures, 0)
  assert.ok(Math.abs(live.height - figure.height) < 1, `no layout shift going live: ${figure.height} → ${live.height}`)
  console.log('web processes while live:', webContents() - baseline)

  // Esc (GPUI holds the keyboard after a synthetic press): back to a picture that keeps Raw.
  await app.getByTestId('app-ready').press('escape')
  await until(async () => (await app.getByTestId('visual-done').count()) === 0, 'back to the picture', 5000)
  await Bun.sleep(500)
  shot('4-returned')

  // Open in a tab: the same document (Raw still pressed), the inline figure says where it is.
  await app.mouse.move(centre(await boxOf(figures, 0))); await Bun.sleep(300)
  await app.mouse.click(centre(await boxOf(app.getByTestId('visual-expand'), 0)))
  await until(async () => (await app.getByTestId('visual-tab').count()) > 0, 'visual tab')
  await Bun.sleep(1200)
  shot('5-tab')
  await app.getByTestId('app-ready').press('cmd-1'); await Bun.sleep(700)
  // The tab let go of it (warm): clicking the picture resumes the same document, Raw still selected.
  await app.mouse.click(centre(await boxOf(figures, 0)))
  await until(async () => (await app.getByTestId('visual-live').count()) > 0, 'resumed live', 8000)
  await Bun.sleep(500)
  shot('6-resumed')
  await app.getByTestId('app-ready').press('escape')
  await until(async () => (await app.getByTestId('visual-done').count()) === 0, 'back to the picture again', 5000)

  // The tall checklist: clamped at 480, Show more grows it.
  await app.mouse.wheel({ x: 1100, y: 400 }, 0, -500); await Bun.sleep(500)
  const tall = await boxOf(figures, 1)
  assert.equal(Math.round(tall.height), 480, 'tall visual rests at 480')
  shot('7-tall')
  await app.getByTestId('visual-more-height').click(); await Bun.sleep(600)
  assert.ok((await boxOf(figures, 1)).height > 900, 'Show more grows it')
  shot('8-tall-expanded')
  console.log(`PASS ${variant}: rest, hover wash, live with replayed click, Esc to picture, tab move, clamp and Show more; web processes now ${webContents() - baseline}`)
} catch (error) { console.log(f.diagnostics()); throw error } finally { await f.close() }
process.exit(0)
