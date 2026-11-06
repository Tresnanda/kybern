// Captures the problem gallery section (`src/kit/gallery/problem.tsx`) in light, dark, glass and increased contrast, with the first
// state's details open, to <out-dir>. Run by hand for the PR screenshots; `scripts/kit-problem-check.ts` is the assertion.
//   bun scripts/kit-problem-shots.ts <out-dir> [light|dark|glass|contrast|all]
import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { launch } from '../native/check-harness.ts'

const out = process.argv[2] ?? 'problem-shots'
const which = process.argv[3] ?? 'all'
mkdirSync(out, { recursive: true })
const LOOKS: Record<string, Record<string, string>> = {
  light: { KYBERN_APPEARANCE: 'light', KYBERN_OPAQUE: '1' },
  dark: { KYBERN_APPEARANCE: 'dark', KYBERN_OPAQUE: '1' },
  glass: { KYBERN_APPEARANCE: 'dark', KYBERN_WINDOW_MATERIAL: 'window', KIT_GLASS: '1' },
  'glass-light': { KYBERN_APPEARANCE: 'light', KYBERN_WINDOW_MATERIAL: 'window', KIT_GLASS: '1' },
  contrast: { KYBERN_APPEARANCE: 'light', KYBERN_OPAQUE: '1', KYBERN_INCREASED_CONTRAST: '1' },
  'contrast-dark': { KYBERN_APPEARANCE: 'dark', KYBERN_OPAQUE: '1', KYBERN_INCREASED_CONTRAST: '1' },
}
for (const look of which === 'all' ? Object.keys(LOOKS) : [which]) {
  const f = await launch(path.join(import.meta.dir, 'kit9-gallery-entry.tsx'), { KIT_SECTION: 'problem', KYBERN_REDUCED_MOTION: '1', ...LOOKS[look]! })
  try {
    await f.app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
    await Bun.sleep(800)
    await f.app.getByTestId('state-0-details').click()
    await f.app.getByTestId('row-0-details').click()
    await Bun.sleep(500)
    await f.app.screenshot({ path: path.join(out, `problem-${look}.png`) })
    console.log('shot', look)
  } finally { await f.close() }
}
process.exit(0)
