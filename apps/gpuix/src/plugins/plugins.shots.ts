// Evidence captures of Settings › Plugins: `SHOT_THEMES=dark,light bun src/plugins/plugins.shots.ts [mode…]`.
// Writes `<out>/<mode>-<theme>.png`.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchFixture } from '../requests/harness.ts'

const out = process.env.SHOT_OUT ?? '/Users/mymac/projects/ade/.kybern-artifacts/ade-86/plugins'
const themes = (process.env.SHOT_THEMES ?? 'dark,light').split(',')
const ALL = ['page', 'page-different', 'page-missing', 'sheet', 'result']
const modes = process.argv.slice(2).length ? process.argv.slice(2) : ALL
mkdirSync(out, { recursive: true })
for (const theme of themes) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'gpuix-plugins-shots-'))
  const fixture = await launchFixture(path.join(import.meta.dir, 'plugins.fixture.tsx'), {
    GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: theme, KYBERN_DATA_DIR: scratch, KYBERN_CLIENT_CONFIG_DIR: scratch, KYBERN_GPUIX_CREDENTIALS_DIR: scratch,
    KYBERN_URL: '', KYBERN_TOKEN: '', KYBERN_GPUIX_ENVIRONMENT: 'local', KYBERN_OPAQUE: '1',
  })
  const app = fixture.app
  const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms + 300))
  const click = async (id: string) => {
    const target = app.getByTestId(id)
    await target.waitFor({ timeoutMs: 15000 })
    await settle(300)
    const deadline = Date.now() + 10000
    while (true) { try { await target.click(); return } catch (e) { if (Date.now() > deadline) throw e; await new Promise((r) => setTimeout(r, 30)) } }
  }
  try {
    await app.getByTestId('fixture-ready').waitFor({ timeoutMs: 60000 })
    for (const mode of modes) { try {
      const base = mode.startsWith('page') ? 'page' : mode
      await click(`fixture-${base === 'page' ? 'sheet' : 'page'}`)
      await click(`fixture-${base}`)
      if (base === 'page') await app.getByTestId('plugin-claude-code:code-review@team-tools').waitFor({timeoutMs: 15000})
      else await app.getByTestId('plugin-copy-sheet').waitFor({timeoutMs: 15000})
      if (mode === 'page-different') await click('plugins-filter-different')
      if (mode === 'page-missing') await click('plugins-filter-missing')
      if (mode === 'result') { await click('plugin-to-vps'); await click('plugin-replace'); await click('plugin-copy-confirm'); await app.getByTestId('plugin-copy-results').waitFor({timeoutMs:15000}) }
      await settle(700)
      await app.screenshot({ path: `${out}/${mode}-${theme}.png` })
      console.log('shot', mode, theme)
    } catch (e) { console.log('FAILED', mode, String(e).slice(0, 160)); await app.screenshot({ path: `${out}/failed-${mode}-${theme}.png` }); throw e } }
  } finally { await fixture.close(); rmSync(scratch, { recursive: true, force: true }) }
}
