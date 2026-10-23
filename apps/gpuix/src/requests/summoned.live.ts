// Real-app evidence for the summoned cards against a SCRATCH daemon that already shows the card:
//   KYBERN_URL=ws://127.0.0.1:<port>/ws KYBERN_TOKEN=<token> KYBERN_DATA_DIR=<scratch> \
//   bun src/requests/summoned.live.ts <thread id> <panel test id> <name> [press key] [wait test id]
// Opens the thread, waits for the panel, optionally presses a digit in the composer (a row) and waits for the next state,
// then writes `<out>/live-<name>-<theme>.png` for dark and glass-dark. Never creates or answers anything itself.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchFixture, waitForPainted } from './harness.ts'

const [thread, panel, name, key, after] = process.argv.slice(2)
if (!thread || !panel || !name) throw new Error('Pass the scratch thread id, the panel test id and a name.')
const out = process.env.SHOT_OUT ?? '/Users/mymac/projects/ade/.kybern-artifacts/ade-69-71/L-requests/live'
mkdirSync(out, { recursive: true })
for (const theme of (process.env.SHOT_THEMES ?? 'dark,glass-dark').split(',')) {
  const glass = theme.startsWith('glass')
  // A fresh client config each launch: a remembered open thread would win over KYBERN_GPUIX_THREAD.
  // The scratch data dir remembers the open thread too.
  rmSync(path.join(process.env.KYBERN_DATA_DIR!, 'gpuix-ui.json'), { force: true })
  const clientDir = mkdtempSync(path.join(tmpdir(), 'gpuix-summoned-live-'))
  const fixture = await launchFixture(path.join(import.meta.dir, '../main.tsx'), {
    GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: 'dark', KYBERN_URL: process.env.KYBERN_URL!, KYBERN_TOKEN: process.env.KYBERN_TOKEN!,
    KYBERN_DATA_DIR: process.env.KYBERN_DATA_DIR!, KYBERN_CLIENT_CONFIG_DIR: clientDir, KYBERN_GPUIX_CREDENTIALS_DIR: clientDir, KYBERN_GPUIX_ENVIRONMENT: 'local', KYBERN_GPUIX_THREAD: thread, KYBERN_REDUCED_MOTION: '1', KYBERN_OPEN_URL_LOG: '/dev/null',
    ...(glass ? { KYBERN_WINDOW_MATERIAL: 'window', KYBERN_WINDOW_OPACITY: '83', KYBERN_WINDOW_CONTENT_OPACITY: '83' } : { KYBERN_OPAQUE: '1' }),
  })
  const app = fixture.app
  try {
    try { await app.getByTestId(panel).waitFor({ timeoutMs: Number(process.env.WAIT_MS ?? 60000) }) } catch (error) { await app.screenshot({ path: `${out}/live-${name}-${theme}-FAILED.png` }); throw error }
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.SETTLE_MS ?? 2500)))
    await app.clock.fastForward(800)
    if (key) {
      await app.getByTestId('composer').fill('')
      await app.getByTestId('composer').press(key)
      await app.getByTestId(after ?? panel).waitFor({ timeoutMs: 20000 })
      await new Promise((resolve) => setTimeout(resolve, Number(process.env.SETTLE_MS ?? 2500)))
      await app.clock.fastForward(800)
    }
    await app.screenshot({ path: `${out}/live-${name}-${theme}.png` })
    console.log('shot', name, theme)
  } finally { await fixture.close(); rmSync(clientDir, { recursive: true, force: true }) }
}
