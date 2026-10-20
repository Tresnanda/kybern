import assert from 'node:assert/strict'
import { pixels } from '../../native/png.ts'
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
    const beforePath = `${out}/popup-reduced-${theme}-closed.png`
    await f.app.screenshot({ path: beforePath })
    await f.app.getByTestId('popup-trigger').click()
    await f.app.getByTestId('popup-panel').waitFor({ timeoutMs: 5000 })
    await waitForPainted(f.app, 'Reduced motion popup')
    await f.app.screenshot({ path: `${out}/popup-reduced-${theme}.png` })
    const rect = await f.app.getByTestId('popup-panel').bounds()
    const before = pixels(beforePath), after = pixels(`${out}/popup-reduced-${theme}.png`)
    const scale = after.w / 600
    let changed = 0, sampled = 0, ink = 0
    // Sample the panel's actual painted interior, not getPaintedText: native
    // text diagnostics include text under an opacity-zero ancestor.
    for (let y = Math.ceil((rect.y + 4) * scale); y < Math.floor((rect.y + rect.height - 4) * scale); y++) {
      for (let x = Math.ceil((rect.x + 4) * scale); x < Math.floor((rect.x + rect.width - 4) * scale); x++) {
        const a = before.at(x, y), b = after.at(x, y)
        if (b.some((value, i) => Math.abs(value - a[i]!) > 12)) changed++
        if (theme === 'dark' ? Math.max(...b) > 140 : Math.min(...b) < 120) ink++
        sampled++
      }
    }
    assert.ok(sampled > 100, 'Popup must have an on-screen painted area')
    assert.ok(changed > sampled * 0.03, `Popup must change visible pixels: ${changed}/${sampled}`)
    assert.ok(ink > 40, `Popup label must have visible contrasting ink: ${ink}`)
    console.log(`PASS ${theme}: PopupLayer menu is visible under KYBERN_REDUCED_MOTION=1`)
  } finally { await f.close(); rmSync(scratch, { recursive: true, force: true }) }
}
process.exit(0)
