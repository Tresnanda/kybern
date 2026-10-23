// Captures `src/kit/gallery/controlsBoard.tsx` (the control system board) to a PNG per theme.
//   bun scripts/kit-controls-board.ts <out-dir> [dark|light|both]
import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { launchFixture } from '../native/frame-harness.ts'
import { guardEnv, CLIENT_DIR } from './kit9-lib.ts'

const out = process.argv[2] ?? '/tmp/controls-board'
const which = process.argv[3] ?? 'both'
mkdirSync(out, { recursive: true })
for (const theme of which === 'both' ? ['dark', 'light'] : [which]) {
  const f = await launchFixture(path.join(import.meta.dir, 'kit9-gallery-entry.tsx'), guardEnv({ KIT_SECTION: 'controls-board', GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: theme, KYBERN_OPAQUE: '1', KYBERN_REDUCED_MOTION: '1', KYBERN_CLIENT_CONFIG_DIR: CLIENT_DIR }))
  try {
    await f.app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
    await Bun.sleep(600)
    await f.app.screenshot({ path: path.join(out, `board-${theme}.png`) })
    console.log('shot', theme)
  } finally { await f.close() }
}
process.exit(0)
