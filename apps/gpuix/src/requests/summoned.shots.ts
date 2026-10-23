// Evidence captures of the summoned cards: `SHOT_THEMES=dark,glass-dark bun src/requests/summoned.shots.ts [mode…]`.
// Writes `<out>/<mode>-<theme>.png`. Themes: dark, light, glass-dark (whole-window glass at 83%).
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchFixture } from './harness.ts'

const out = process.env.SHOT_OUT ?? '/Users/mymac/projects/ade/.kybern-artifacts/ade-69-71/L-requests/ui'
const themes = (process.env.SHOT_THEMES ?? 'dark').split(',')
const ALL = ['login-ask', 'login-wait', 'login-terminal', 'login-paste', 'login-done', 'login-failed', 'password-sudo', 'password-wrong', 'password-passphrase', 'password-hostkey', 'password-git-user', 'password-git-pass', 'permission-ask', 'permission-wait', 'permission-done', 'permission-off', 'permission-fda', 'deadline', 'deadline-paused', 'deadline-last', 'records', 'settings']
const modes = process.argv.slice(2).length ? process.argv.slice(2) : ALL
mkdirSync(out, { recursive: true })
for (const theme of themes) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'gpuix-summoned-shots-'))
  const glass = theme.startsWith('glass')
  const fixture = await launchFixture(path.join(import.meta.dir, 'summoned.fixture.tsx'), {
    GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: theme.endsWith('light') ? 'light' : 'dark', KYBERN_DATA_DIR: scratch, KYBERN_CLIENT_CONFIG_DIR: scratch, KYBERN_GPUIX_CREDENTIALS_DIR: scratch,
    KYBERN_URL: '', KYBERN_TOKEN: '', KYBERN_GPUIX_ENVIRONMENT: 'local', KYBERN_REDUCED_MOTION: '1', KYBERN_OPEN_URL_LOG: path.join(scratch, 'opened.log'),
    ...(glass ? { FIXTURE_WALLPAPER: path.resolve(import.meta.dir, '../../../desktop/public/release-background.png'), KYBERN_WINDOW_MATERIAL: 'window', KYBERN_WINDOW_OPACITY: '83', KYBERN_WINDOW_CONTENT_OPACITY: '83' } : { KYBERN_OPAQUE: '1' }),
  })
  const app = fixture.app
  try {
    for (const mode of modes) {
      await app.getByTestId(`fixture-${mode}`).click()
      await app.clock.fastForward(600)
      await app.screenshot({ path: `${out}/${mode}-${theme}.png` })
      console.log('shot', mode, theme)
    }
  } finally { await fixture.close(); rmSync(scratch, { recursive: true, force: true }) }
}
