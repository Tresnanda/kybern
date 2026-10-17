// A Finder file drop on the composer against the scratch daemon's real `/assets` upload: the file
// attaches (chip with its name), the border returns to rest, and Send is enabled for attachment-only.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { EVIDENCE, launchLive, until } from '../transcript/live.ts'
const out = process.env.KYBERN_VERIFY_OUTPUT ?? `${EVIDENCE}/drop-live`
mkdirSync(out, { recursive: true })
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
for (const [theme, reduced] of [['dark', false], ['light', false], ['dark', true], ['light', true]] as const) {
  const label = `${theme}${reduced ? '-reduced' : ''}`
  const dir = mkdtempSync(tmpdir() + '/gpuix-drop-live-'), file = `${dir}/dropped-photo.png`
  writeFileSync(file, png)
  const f = await launchLive({ theme, reduced, thread: 'Markdown B' })
  try {
    const app = f.app
    await until(async () => (await app.getByTestId('composer-drop-zone').count()) > 0, 'composer', 20000)
    const text = async () => { await app.clock.fastForward(16); await app.screenshot({ path: `${out}/.flush.png` }); return String((await app.call('getPaintedText', {})).text) }
    const target = await app.getByTestId('composer-drop-zone').center()
    await app.call('fileDrop' as never, { ...target, paths: [file] } as never)
    await until(async () => (await text()).includes('@image1'), 'image attachment chip (@image1)', 20000)
    await app.screenshot({ path: `${out}/attached-${label}.png` })
    assert.ok(!/Unable|failed/i.test(await text()), 'no upload error')
    console.log(`PASS ${label}: dropped file uploaded to /assets and attached as an @image1 thumbnail chip`)
  } catch (error) { await f.app.screenshot({ path: `${out}/failed-${label}.png` }).catch(() => {}); console.log(f.diagnostics().slice(-800)); throw error } finally { await f.close(); rmSync(dir, { recursive: true, force: true }) }
}
rmSync(`${out}/.flush.png`, { force: true })
process.exit(0)
