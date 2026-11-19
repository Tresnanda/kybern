// Inline visuals (ADE-69; live while visible since the inline-pages change). Seed first (`visual.seed.ts`), then:
//   VISUAL_SCRATCH=… bun src/transcript/visual.verify.ts [dark|light|glass]
// A visual on screen is live without a press (its picture first, then the page in place, same height); the tall
// checklist is as tall as its page, with no clamp or Show more; Open in a tab moves the same document and the figure
// takes it back live when the tab lets go. The wheel, presses and keys inside a live page are AppKit-level:
// `scripts/inline-visual-check.ts` covers them. Pages are captured with `screencapture -l` (the GPUI screenshot API
// omits child NSViews).
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
  shot('1-picture')
  // On screen: live without a press, in place, at the same height.
  await until(async () => (await app.getByTestId('visual-live').count()) > 0, 'live without a press', 15000)
  await Bun.sleep(600)
  shot('2-live')
  const live = await boxOf(figures, 0)
  assert.ok(Math.abs(live.height - figure.height) < 1, `no layout shift going live: ${figure.height} → ${live.height}`)
  console.log('web processes while live:', webContents() - baseline)

  // Open in a tab: the same document; the inline figure says where it is, then takes it back live.
  await app.mouse.move(centre(await boxOf(figures, 0))); await Bun.sleep(300)
  await app.mouse.click(centre(await boxOf(app.getByTestId('visual-expand'), 0)))
  await until(async () => (await app.getByTestId('visual-tab').count()) > 0, 'visual tab')
  await Bun.sleep(1200)
  shot('3-tab')
  await app.getByTestId('app-ready').press('cmd-1'); await Bun.sleep(700)
  await until(async () => (await app.getByTestId('visual-live').count()) > 0, 'live again after the tab', 8000)
  shot('4-back')

  // The tall checklist: as tall as its page, nothing to show more of.
  await app.mouse.wheel({ x: 1100, y: 400 }, 0, -500); await Bun.sleep(500)
  const tall = await boxOf(figures, 1)
  assert.ok(tall.height > 900, `the tall visual is as tall as its page: ${tall.height}`)
  assert.equal(await app.getByTestId('visual-more-height').count(), 0, 'no Show more')
  shot('5-tall')
  console.log(`PASS ${variant}: live without a press, no shift, tab move and back, full height; web processes now ${webContents() - baseline}`)
} catch (error) { console.log(f.diagnostics()); throw error } finally { await f.close() }
process.exit(0)
