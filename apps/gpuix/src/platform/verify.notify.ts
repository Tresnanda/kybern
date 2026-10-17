// OS notifications from the packaged app (bundle id dev.kybern.gpuix) while its
// window is unfocused: Settings › Notifications shows the access state, then a
// real turn on the scratch daemon finishes and the app posts "Finished
// working" through UNUserNotificationCenter, plus the in-app toast.
//
//   KYBERN_DATA_DIR=<scratch> bun src/platform/verify.notify.ts <thread id> <out-dir> [dark|light]
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../../packaging/harness.ts'
import { assertScratchDataDir, until, windowId } from './verify.lib.ts'

assertScratchDataDir()

const [thread, out, theme = 'dark'] = process.argv.slice(2) as [string, string, string?]
assert.ok(thread && out)
mkdirSync(out, { recursive: true })
const { app, pid, diagnostics, close } = await launchFixture('', { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: theme, KYBERN_DEBUG_NOTIFICATIONS: '1' })
const shot = (name: string) => execFileSync('screencapture', ['-x', '-o', '-l', String(windowId(pid)), path.join(out, `${name}-${theme}.png`)])
try {
  await app.getByTestId('rail-settings').click()
  await app.getByTestId('settings-tab-notifications').click()
  await app.getByText('System alerts appear when Kybern is in the background.').waitFor({ timeoutMs: 15_000 })
  await Bun.sleep(600)
  shot('settings-notifications-granted')
  console.log('ok  packaged app reports notification access granted')
  await app.getByTestId('settings-back').click()
  const cli = path.resolve(import.meta.dir, '../../dist/Kybern GPUIX.app/Contents/MacOS/kybern')
  execFileSync(cli, ['--data-dir', process.env.KYBERN_DATA_DIR!, 'send', thread, 'Reply with only the word OK. Do not use any tools.'], { stdio: 'ignore', timeout: 120_000 })
  const posted = await until(() => /\[notifications\] (posted|not posted).*/.exec(diagnostics())?.[0], 'notification attempt', 20_000)
  console.log(posted)
  assert.ok(posted.startsWith('[notifications] posted true') && posted.includes('Finished working'))
  await app.getByTestId('toast-default').waitFor({ timeoutMs: 5000 })
  await Bun.sleep(500)
  shot('finished-toast')
  console.log('ok  unfocused window: OS notification posted and in-app toast shown')
} finally { await close() }
process.exit(0)
