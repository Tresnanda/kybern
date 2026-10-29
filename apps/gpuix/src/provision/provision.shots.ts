// Evidence captures of "Add to another machine": `SHOT_THEMES=dark bun src/provision/provision.shots.ts [mode…]`.
// Writes `<out>/<mode>-<theme>.png`.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchFixture } from '../requests/harness.ts'

const out = process.env.SHOT_OUT ?? '/Users/mymac/projects/ade/.kybern-artifacts/ade-86/provision'
const themes = (process.env.SHOT_THEMES ?? 'dark').split(',')
const ALL = ['sheet', 'sheet-chooser', 'sheet-taken', 'sheet-progress', 'sheet-done', 'card', 'card-chooser', 'records']
const modes = process.argv.slice(2).length ? process.argv.slice(2) : ALL
mkdirSync(out, { recursive: true })
for (const theme of themes) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'gpuix-provision-shots-'))
  const fixture = await launchFixture(path.join(import.meta.dir, 'provision.fixture.tsx'), {
    GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: theme.endsWith('light') ? 'light' : 'dark', KYBERN_DATA_DIR: scratch, KYBERN_CLIENT_CONFIG_DIR: scratch, KYBERN_GPUIX_CREDENTIALS_DIR: scratch,
    KYBERN_URL: '', KYBERN_TOKEN: '', KYBERN_GPUIX_ENVIRONMENT: 'local', KYBERN_OPAQUE: '1',
  })
  const app = fixture.app
  const settle = async (ms = 400) => { await new Promise((r) => setTimeout(r, ms + 300)) }
  const click = async (id: string) => {
    const target = app.getByTestId(id)
    await target.waitFor({ timeoutMs: 15000 })
    await settle(350)
    const deadline = Date.now() + 10000
    while (true) { try { await target.click(); return } catch (e) { if (Date.now() > deadline) throw e; await new Promise((r) => setTimeout(r, 30)) } }
  }
  try {
    await app.getByTestId('fixture-ready').waitFor({ timeoutMs: 60000 })
    for (const mode of modes) { try {
      const base = mode === 'card-chooser' ? 'card' : mode === 'sheet-done' ? 'sheet-done' : mode.startsWith('sheet') ? 'sheet' : mode
      await click(`fixture-${base}`)
      if (base.startsWith('sheet')) await app.getByTestId('provision-folder').waitFor({ timeoutMs: 15000 })
      if (base === 'card') await app.getByTestId('provision-card-folder').waitFor({ timeoutMs: 15000 })
      await settle(600)
      if (mode === 'sheet-chooser') { await click('provision-folder-choose'); await app.getByText('ade-network-test').waitFor({ timeoutMs: 15000 }) }
      if (mode === 'card-chooser') { await click('provision-card-folder-choose'); await app.getByText('ade-network-test').waitFor({ timeoutMs: 15000 }) }
      if (mode === 'sheet-taken') { await app.getByTestId('provision-folder').fill('/home/tresnanda/projects/gallery'); await settle(900); await new Promise((r) => setTimeout(r, 700)) }
      if (mode === 'sheet-progress' || mode === 'sheet-done') { for (let i = 0; i < 8 && await app.getByTestId('provision-status').count() === 0; i++) { await settle(800); try { await app.getByTestId('provision-confirm').click() } catch { /* gone: the status shows */ } } await app.getByTestId('provision-status').waitFor({ timeoutMs: 15000 }) }
      await settle(600)
      await app.screenshot({ path: `${out}/${mode}-${theme}.png` })
      console.log('shot', mode, theme)
    } catch (e) { console.log('FAILED', mode, String(e).slice(0, 120)); await app.screenshot({ path: `${out}/failed-${mode}-${theme}.png` }) } }
  } finally { await fixture.close(); rmSync(scratch, { recursive: true, force: true }) }
}
