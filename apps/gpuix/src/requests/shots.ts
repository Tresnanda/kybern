// Evidence captures of every request kind: `SHOT_TAG=after SHOT_THEMES=dark,glass-dark bun src/requests/shots.ts [mode…]`.
// Writes `<out>/<tag>-<mode>-<theme>.png`. Themes: dark, light, glass-dark, glass-light (whole-window glass at 83%).
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchFixture } from './harness.ts'

const out = process.env.SHOT_OUT ?? '/Users/mymac/projects/ade/.kybern-artifacts/ade-54-58/L4'
const tag = process.env.SHOT_TAG ?? 'after'
const themes = (process.env.SHOT_THEMES ?? 'dark').split(',')
const modes = process.argv.slice(2).length ? process.argv.slice(2) : ['command', 'approval', 'long', 'edit', 'plan', 'connector', 'computer', 'computer-fg', 'note', 'grant', 'secret', 'question', 'question-multi', 'queue', 'sending']
mkdirSync(out, { recursive: true })
for (const theme of themes) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'gpuix-requests-shots-'))
  const glass = theme.startsWith('glass')
  const fixture = await launchFixture(path.join(import.meta.dir, 'parity.fixture.tsx'), {
    GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: theme.endsWith('light') ? 'light' : 'dark', KYBERN_DATA_DIR: scratch, KYBERN_CLIENT_CONFIG_DIR: scratch, KYBERN_GPUIX_CREDENTIALS_DIR: scratch,
    KYBERN_URL: '', KYBERN_TOKEN: '', KYBERN_GPUIX_ENVIRONMENT: 'local', KYBERN_REDUCED_MOTION: '1',
    ...(glass ? { FIXTURE_WALLPAPER: path.resolve(import.meta.dir, '../../../../assets/release-background.png'), KYBERN_WINDOW_MATERIAL: 'window', KYBERN_WINDOW_OPACITY: '83', KYBERN_WINDOW_CONTENT_OPACITY: '83' } : { KYBERN_OPAQUE: '1' }),
  })
  const app = fixture.app
  try {
    for (const mode of modes) {
      await app.getByTestId(`fixture-${mode}`).click()
      await app.clock.fastForward(400)
      if (mode === 'sending') { await app.getByTestId((await app.getByTestId('approval-row-1').count()) ? 'approval-row-1' : 'approval-primary').click(); await app.clock.fastForward(300) }
      await app.screenshot({ path: `${out}/${tag}-${mode}-${theme}.png` })
      console.log('shot', tag, mode, theme)
    }
  } finally { await fixture.close(); rmSync(scratch, { recursive: true, force: true }) }
}
