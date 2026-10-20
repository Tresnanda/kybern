// A Finder drag over the composer card: the border takes the focus colour while
// the pointer is over it (`dragOver && border-[color:var(--color-border-focus)]`)
// and returns when it leaves the card or the drag ends; a real drop attaches.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { launchFixture } from '../requests/harness.ts'
import { pixels } from '../../native/png.ts'
const out = process.env.KYBERN_VERIFY_OUTPUT ?? '/Users/mymac/projects/ade/previews/gpuix/phase2/convo9/drop'
mkdirSync(out, { recursive: true })
const until = async (check: () => Promise<boolean>, label: string) => { for (let i = 0; i < 100; i++) { try { if (await check()) return } catch {} await Bun.sleep(40) } throw Error(`Timed out: ${label}`) }
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
for (const variant of ['dark', 'light'] as const) for (const reduced of ['0', '1']) {
  const scratch = mkdtempSync(tmpdir() + '/gpuix-drop-')
  const file = scratch + '/dropped.png'; writeFileSync(file, png)
  const f = await launchFixture(import.meta.dir + '/conversation.fixture.tsx', { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: variant, KYBERN_REDUCED_MOTION: reduced, KYBERN_DATA_DIR: scratch, KYBERN_CLIENT_CONFIG_DIR: scratch, KYBERN_GPUIX_CREDENTIALS_DIR: scratch, KYBERN_GPUIX_ENVIRONMENT: 'local', KYBERN_URL: '', KYBERN_TOKEN: '', KYBERN_FIXTURE_DRAG_FILE: file })
  const label = `${variant}${reduced === '1' ? '-reduced' : ''}`
  try {
    const app = f.app
    await app.getByTestId('conversation-ready').waitFor()
    await until(async () => (await app.getByTestId('connected').textContent()) === 'open', 'connected')
    const zone = await app.getByTestId('composer-drop-zone').bounds()
    // Top edge: the 1px border row, away from the corner radius. The ring eases over 200 ms (motion/DropHighlight.tsx),
    // so each step waits past it.
    const edge = async (name: string) => {
      const path = `${out}/${name}-${label}.png`
      await app.screenshot({ path })
      const image = pixels(path), scale = image.w / 1280
      // The most saturated pixel in the rows around the top edge: the focus border is blue, the resting one grey.
      let best = image.at((zone.x + zone.width / 2) * scale, zone.y * scale - 3), spread = 0
      for (let row = -3; row <= 4; row++) {
        const px = image.at((zone.x + zone.width / 2) * scale, zone.y * scale + row), s = Math.max(...px) - Math.min(...px)
        if (s > spread) { spread = s; best = px }
      }
      return spread > 6 ? best : [0, 0, 0]
    }
    const rest = await edge('rest')
    await app.getByTestId('drag-enter').click(); await Bun.sleep(320)
    // The probe buttons sit above the card; the simulated pointer is at (640, 700), inside it.
    const over = await edge('drag-over')
    assert.notDeepEqual(over, rest, `border did not change over the card: ${rest} → ${over}`)
    await app.getByTestId('drag-outside').click(); await Bun.sleep(320)
    assert.deepEqual(await edge('drag-outside'), rest, 'border must return when the pointer leaves the card')
    await app.getByTestId('drag-enter').click(); await Bun.sleep(150)
    await app.getByTestId('drag-exit').click(); await Bun.sleep(320)
    assert.deepEqual(await edge('drag-ended'), rest, 'border must return when the drag ends')
    const target = await app.getByTestId('composer-drop-zone').center()
    await app.call('fileDrop' as never, { ...target, paths: [file] } as never)
    // The fixture daemon has no /assets endpoint, so the upload fails visibly; scripts/composer-io-check.ts
    // covers the successful attach against a mock boundary. Here the drop must be received and answered.
    await until(async () => { const text = String((await app.call('getPaintedText', {})).text); return /Unable|dropped\.png|image1/.test(text) }, 'drop feedback')
    assert.deepEqual(await edge('dropped'), rest, 'border must return after the drop')
    console.log(`PASS ${label}: drag-over border ${rest} → ${over}, restored on leave, end and drop; the drop was received and answered`)
  } catch (error) { await f.app.screenshot({ path: `${out}/failed-${label}.png` }).catch(() => {}); console.log(f.diagnostics()); throw error } finally { await f.close(); rmSync(scratch, { recursive: true, force: true }) }
}
process.exit(0)
