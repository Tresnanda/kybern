// Evidence captures for Settings › Computer use (ADE-83): `SHOT_THEMES=dark,light bun src/settings/computer.shots.ts [mode…]`.
// Writes `<out>/<mode>-<theme>.png`. FIXTURE_FRAME is a PNG used as the live frame.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchFixture } from '../requests/harness.ts'

const out = process.env.SHOT_OUT ?? '/Users/mymac/projects/ade/.kybern-artifacts/ade-83'
const themes = (process.env.SHOT_THEMES ?? 'dark,light').split(',')
const ALL = ['mac-cua', 'mac-cua-missing', 'mac-agent', 'mac-agent-granted', 'windows', 'linux-wayland', 'linux-long', 'old-daemon', 'live-paused', 'live-paused-only']
const modes = process.argv.slice(2).length ? process.argv.slice(2) : ALL
mkdirSync(out, { recursive: true })
for (const theme of themes) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'gpuix-computer-shots-'))
  const live = modes.some((mode) => mode.startsWith('live'))
  const fixture = await launchFixture(path.join(import.meta.dir, 'computer.fixture.tsx'), {
    GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: theme, KYBERN_DATA_DIR: scratch, KYBERN_CLIENT_CONFIG_DIR: scratch, KYBERN_GPUIX_CREDENTIALS_DIR: scratch,
    KYBERN_URL: '', KYBERN_TOKEN: '', KYBERN_GPUIX_ENVIRONMENT: 'local', KYBERN_REDUCED_MOTION: '1', KYBERN_OPAQUE: '1', KYBERN_OPEN_URL_LOG: path.join(scratch, 'opened.log'),
    ...(process.env.FIXTURE_FRAME ? { FIXTURE_FRAME: process.env.FIXTURE_FRAME } : {}), ...(process.env.FIXTURE_SHIFT ? { FIXTURE_SHIFT: process.env.FIXTURE_SHIFT } : {}), ...(process.env.FIXTURE_WIDTH ? { FIXTURE_WIDTH: process.env.FIXTURE_WIDTH } : {}), ...(live ? { FIXTURE_HEIGHT: '700' } : { FIXTURE_HEIGHT: '900' }),
  })
  const app = fixture.app
  try {
    for (const mode of modes) {
      if (mode === 'live-paused' || mode === 'live-paused-only') {
        // 'live-paused-only' must be the first live mode of a launch, so no frame was ever shown.
        if (mode === 'live-paused') {
          await app.getByTestId('fixture-live-ok').click()
          await app.getByTestId('computer-live-image').waitFor({ timeoutMs: 20_000 })
        }
        await app.getByTestId(`fixture-${mode}`).click()
        await app.getByTestId('computer-live-paused').waitFor({ timeoutMs: 20_000 })
      } else await app.getByTestId(`fixture-${mode}`).click()
      await app.clock.fastForward(1500)
      await Bun.sleep(600)
      await app.screenshot({ path: `${out}/${mode}-${theme}.png` })
      console.log('shot', mode, theme)
    }
  } finally { await fixture.close(); rmSync(scratch, { recursive: true, force: true }) }
}
