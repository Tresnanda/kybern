// Hover, pressed and keyboard-focus captures of a few controls on the board (`gallery/controlsBoard.tsx`).
//   bun scripts/kit-controls-states.ts <out-dir> [dark|light]
import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { launchFixture } from '../native/frame-harness.ts'
import { guardEnv, CLIENT_DIR } from './kit9-lib.ts'

const out = process.argv[2] ?? '/tmp/controls-states'
const theme = process.argv[3] ?? 'dark'
mkdirSync(out, { recursive: true })
const f = await launchFixture(path.join(import.meta.dir, 'kit9-gallery-entry.tsx'), guardEnv({ KIT_SECTION: 'controls-board', GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: theme, KYBERN_OPAQUE: '1', KYBERN_REDUCED_MOTION: '1', KYBERN_CLIENT_CONFIG_DIR: CLIENT_DIR }))
try {
  const app = f.app
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
  await Bun.sleep(600)
  const shot = async (name: string) => { await Bun.sleep(300); await app.screenshot({ path: path.join(out, `${name}-${theme}.png`) }); console.log('shot', name) }
  for (const id of ['b-primary', 'b-secondary', 'b-ghost', 'b-destructive', 'b-icon', 'b-chip', 'b-check', 'b-field']) {
    await app.getByTestId(id).hover()
    await shot(`hover-${id}`)
  }
  await app.mouse.move({ x: 1275, y: 815 })
  // Keyboard focus: tab through the first controls.
  for (let i = 0; i < 6; i++) { await app.getByTestId('app-ready').press('tab'); await shot(`focus-tab${i + 1}`) }
} finally { await f.close() }
process.exit(0)
