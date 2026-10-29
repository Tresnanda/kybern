// Evidence captures of the machine network's intro: `SHOT_THEMES=dark,light bun src/machines/intro.shots.ts [mode…]`.
// Writes `<out>/<mode>-<theme>.png`, and `auto-<theme>.png`: the intro as it opens by itself.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchFixture } from '../requests/harness.ts'

const out = process.env.SHOT_OUT ?? '/Users/mymac/projects/ade/.kybern-artifacts/ade-86/intro'
const themes = (process.env.SHOT_THEMES ?? 'dark').split(',')
const ALL = ['intro', 'intro-stopped', 'intro-missing', 'on', 'on-joined', 'settings', 'settings-missing', 'settings-on']
const modes = process.argv.slice(2).length ? process.argv.slice(2) : ALL
mkdirSync(out, { recursive: true })
for (const theme of themes) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'gpuix-intro-shots-'))
  const fixture = await launchFixture(path.join(import.meta.dir, 'intro.fixture.tsx'), {
    GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: theme, KYBERN_DATA_DIR: scratch, KYBERN_CLIENT_CONFIG_DIR: scratch, KYBERN_GPUIX_CREDENTIALS_DIR: scratch,
    KYBERN_URL: '', KYBERN_TOKEN: '', KYBERN_GPUIX_ENVIRONMENT: 'local', KYBERN_OPAQUE: '1',
  })
  const app = fixture.app
  const settle = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const click = async (id: string) => {
    const target = app.getByTestId(id)
    await target.waitFor({ timeoutMs: 15000 })
    const deadline = Date.now() + 10000
    while (true) { try { await target.click(); return } catch (e) { if (Date.now() > deadline) throw e; await settle(30) } }
  }
  try {
    await app.getByTestId('fixture-ready').waitFor({ timeoutMs: 60000 })
    // The intro opens by itself: the scratch config has no answer and the fixture's network is off.
    await app.getByTestId('network-intro-on').waitFor({ timeoutMs: 15000 })
    await settle(1200)
    await app.screenshot({ path: `${out}/auto-${theme}.png` })
    console.log('shot', 'auto', theme)
    await click('network-intro-later')
    await settle(800)
    for (const mode of modes) { try {
      await click(`fixture-${mode}`)
      await settle(1600)
      await app.screenshot({ path: `${out}/${mode}-${theme}.png` })
      console.log('shot', mode, theme)
      // Close the dialog so the next mode's button can be pressed.
      for (const id of ['network-intro-later', 'network-intro-done']) if (await app.getByTestId(id).count()) { await click(id); break }
      await settle(500)
    } catch (e) { console.log('FAILED', mode, String(e).slice(0, 160)); await app.screenshot({ path: `${out}/failed-${mode}-${theme}.png` }) } }
  } finally { await fixture.close(); rmSync(scratch, { recursive: true, force: true }) }
}
