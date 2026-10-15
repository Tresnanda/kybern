import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { launchFixture, waitForPainted } from '../requests/harness.ts'
const out = process.env.KYBERN_VERIFY_OUTPUT ?? '/Users/mymac/projects/ade/previews/gpuix/popup'
mkdirSync(out, { recursive: true })
// Regression: with Reduce Motion a zero-length opacity tween left PopupLayer menus at opacity 0.
for (const theme of ['dark', 'light']) {
  const scratch = mkdtempSync(tmpdir() + '/gpuix-popup-')
  const f = await launchFixture(import.meta.dir + '/popup-reduced.fixture.tsx', { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: theme, KYBERN_REDUCED_MOTION: '1', KYBERN_DATA_DIR: scratch, KYBERN_CLIENT_CONFIG_DIR: scratch, KYBERN_GPUIX_CREDENTIALS_DIR: scratch })
  try {
    await f.app.getByTestId('popup-ready').waitFor({ timeoutMs: 60_000 })
    await f.app.getByTestId('popup-trigger').click()
    await f.app.getByTestId('popup-panel').waitFor({ timeoutMs: 5000 })
    await waitForPainted(f.app, 'Reduced motion popup')
    await f.app.screenshot({ path: `${out}/popup-reduced-${theme}.png` })
    console.log(`PASS ${theme}: PopupLayer menu is visible under KYBERN_REDUCED_MOTION=1`)
  } finally { await f.close(); rmSync(scratch, { recursive: true, force: true }) }
}
process.exit(0)
