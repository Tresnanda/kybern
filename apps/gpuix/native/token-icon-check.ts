// The composer's chip icons sit in the room the chip reserves, left of the label, on every OS (token-icon-lab.tsx). Each mode runs with the app's fonts and without the code face (the case that
// put the icon over the label's first letters). Writes `token-icon-{dark,light}-{fonts,nofonts}.png` to KYBERN_VERIFY_OUTPUT.
import '../src/native/local-build.ts'
import path from 'node:path'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { launchFixture } from '../src/requests/harness.ts'
const out = process.env.KYBERN_VERIFY_OUTPUT ?? path.join(import.meta.dir, 'build')
mkdirSync(out, { recursive: true })
for (const [mode, fonts] of [['dark', 'fonts'], ['light', 'fonts'], ['dark', 'nofonts'], ['light', 'nofonts']] as const) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'gpuix-token-icon-'))
  const f = await launchFixture(path.join(import.meta.dir, 'token-icon-lab.tsx'), { KYBERN_APPEARANCE: mode, ...(fonts === 'nofonts' ? { KYBERN_LAB_NO_FONTS: '1' } : {}), GPUIX_BACKGROUND: '1', KYBERN_DATA_DIR: scratch, KYBERN_CLIENT_CONFIG_DIR: scratch, KYBERN_URL: '', KYBERN_TOKEN: '' })
  try {
    await f.app.getByTestId('app-ready').waitFor()
    await Bun.sleep(800)
    await f.app.screenshot({ path: path.join(out, `token-icon-${mode}-${fonts}.png`) })
    console.log(`captured ${mode} ${fonts}`)
  } catch (e) { console.error(f.diagnostics()); throw e }
  finally { await f.close() }
}
