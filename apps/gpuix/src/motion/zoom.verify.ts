// The image preview's zoom in the real app (lightbox and image tab), against a tall screenshot sheet:
//   NAPI_RS_NATIVE_LIBRARY_PATH=…patched.node bun src/motion/zoom.verify.ts
// Opens fitted to the width; double click goes to 100% at the click and back; ⌘+ ⌘− ⌘0, ⌘-scroll, two-finger scroll and a drag
// move it; every state is read from the stage's own bounds and a screenshot is kept under KYBERN_VERIFY_OUTPUT.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { launchFixture } from '../requests/harness.ts'
const out = process.env.KYBERN_VERIFY_OUTPUT ?? '/Users/mymac/projects/ade/.kybern-artifacts/ade-54-58/L6/zoom'
const image = process.env.ZOOM_IMAGE ?? '/Users/mymac/projects/ade/.kybern-artifacts/ade-approval-design/family-dark.png'
mkdirSync(out, { recursive: true })
const modes = (process.env.ZOOM_MODES ?? 'lightbox,tab').split(','), themes = (process.env.ZOOM_THEMES ?? 'dark').split(',')
let failures = 0
for (const mode of modes) for (const theme of themes) {
  const scratch = mkdtempSync(tmpdir() + '/gpuix-zoom-')
  const f = await launchFixture(import.meta.dir + '/zoom.fixture.tsx', { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: theme, KYBERN_DATA_DIR: scratch, KYBERN_CLIENT_CONFIG_DIR: scratch, KYBERN_GPUIX_CREDENTIALS_DIR: scratch, KYBERN_GPUIX_ENVIRONMENT: 'local', KYBERN_URL: '', KYBERN_TOKEN: '', ZOOM_MODE: mode, ZOOM_IMAGE: image })
  const name = `${mode}-${theme}`
  try {
    const app = f.app
    const surface = app.getByTestId(mode === 'tab' ? 'image-tab-zoom' : 'image-lightbox-zoom-surface')
    const stage = app.getByTestId(mode === 'tab' ? 'image-tab-zoom-stage' : 'image-lightbox-zoom-surface-stage')
    const hud = app.getByTestId(mode === 'tab' ? 'image-tab-zoom-hud-percent' : 'image-lightbox-zoom-percent')
    await surface.waitFor({ timeoutMs: 60_000 })
    await Bun.sleep(600)
    const percent = async () => (await hud.textContent()).trim()
    const stageBox = async () => { const b = await stage.bounds(); return { x: b.x, y: b.y, w: b.width, h: b.height } }
    const shot = async (label: string) => { await Bun.sleep(350); await app.screenshot({ path: `${out}/${name}-${label}.png` }) }
    const view = await surface.bounds()
    console.log(name, 'viewport', JSON.stringify({ x: view.x, y: view.y, w: view.width, h: view.height }), 'stage', JSON.stringify(await stageBox()), await percent())
    await shot('1-fit')
    // Double click toggles to 100%, anchored at the point.
    const at = { x: view.x + view.width * 0.5, y: view.y + 120 }
    await app.call('click', at); await app.call('click', at)
    await Bun.sleep(500)
    console.log(name, 'after dblclick', await percent(), JSON.stringify(await stageBox()))
    await shot('2-actual')
    await app.call('click', at); await app.call('click', at)
    await Bun.sleep(500)
    console.log(name, 'back', await percent())
    await surface.press('cmd-=')
    await Bun.sleep(400)
    console.log(name, 'cmd+', await percent())
    await shot('3-cmd-plus')
    await surface.wheel(0, 80, { modifiers: 'cmd' }) // wheel rolled up: zooms in
    await Bun.sleep(300)
    console.log(name, 'cmd-scroll', await percent())
    await surface.wheel(0, -120)
    await Bun.sleep(300)
    console.log(name, 'scrolled', JSON.stringify(await stageBox()))
    await surface.dragBy(-100, -60)
    await Bun.sleep(300)
    console.log(name, 'dragged', JSON.stringify(await stageBox()))
    await surface.press('cmd-0')
    await Bun.sleep(400)
    console.log(name, 'cmd0', await percent())
  } catch (error) { failures++; console.log(name, String(error)); await f.app.screenshot({ path: `${out}/${name}-failed.png` }).catch(() => {}) } finally { await f.close(); rmSync(scratch, { recursive: true, force: true }) }
}
process.exit(failures ? 1 : 0)
