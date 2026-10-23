// Keys and actions of the summoned cards against their native fixture (all in memory): sign-in rows go to `requests.act`, the host
// key ignores Return, the password card answers `submit`, a deadline question pauses on a key, the sign-in chip queues its message.
// `bun src/requests/summoned.verify.ts` with `NAPI_RS_NATIVE_LIBRARY_PATH` set to a patched addon.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchFixture } from './harness.ts'

const scratch = mkdtempSync(path.join(tmpdir(), 'gpuix-summoned-verify-'))
const fixture = await launchFixture(path.join(import.meta.dir, 'summoned.fixture.tsx'), {
  GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: 'dark', KYBERN_DATA_DIR: scratch, KYBERN_CLIENT_CONFIG_DIR: scratch, KYBERN_GPUIX_CREDENTIALS_DIR: scratch,
  KYBERN_URL: '', KYBERN_TOKEN: '', KYBERN_GPUIX_ENVIRONMENT: 'local', KYBERN_REDUCED_MOTION: '1', KYBERN_OPAQUE: '1', KYBERN_OPEN_URL_LOG: path.join(scratch, 'opened.log'),
})
const app = fixture.app
const has = async (testId: string) => (await app.getByTestId(testId).count()) > 0
const settle = () => app.clock.fastForward(300)
const mode = async (name: string, ready: string) => { await app.getByTestId(`fixture-${name}`).click(); await app.getByTestId(ready).waitFor({ timeoutMs: 10000 }); await settle() }
try {
  // Sign-in: digit 1 in the empty composer starts the browser path through `requests.act`, never `approvals.respond`.
  await mode('login-ask', 'login-panel')
  await app.getByTestId('composer').fill('')
  await app.getByTestId('composer').press('1')
  await app.getByTestId('acted-browser').waitFor({ timeoutMs: 5000 })
  assert.ok(!(await has('responded-submit')), 'a sign-in row must not answer the approval')
  console.log('ok: sign-in row 1 = requests.act browser')

  // Waiting: Esc on the card cancels the sign-in.
  await mode('login-wait', 'login-status')
  await app.getByTestId('login-panel').press('escape')
  await app.getByTestId('acted-cancel').waitFor({ timeoutMs: 5000 })
  console.log('ok: Esc while waiting = requests.act cancel')

  // Host key: Return is inert, digit 1 trusts.
  await mode('password-hostkey', 'hostkey-well')
  const card = app.getByTestId('prompt-panel')
  await card.press('enter')
  await settle()
  assert.ok(!(await has('responded-submit')), 'Return must not trust a host')
  await card.press('1')
  await app.getByTestId('responded-submit').waitFor({ timeoutMs: 5000 })
  console.log('ok: host key ignores Return, 1 trusts')

  // Password: Send is disabled until there is a value; Return in the field sends `submit`.
  await mode('password-sudo', 'prompt-input')
  await app.getByTestId('prompt-input').fill('hunter2')
  await app.getByTestId('prompt-input').press('enter')
  await app.getByTestId('responded-submit').waitFor({ timeoutMs: 5000 })
  console.log('ok: password field sends submit')

  // Permission: row 1 opens System Settings (logged) and tells the daemon.
  await mode('permission-ask', 'permission-panel')
  await app.getByTestId('permission-row-open').click()
  await app.getByTestId('acted-open').waitFor({ timeoutMs: 5000 })
  console.log('ok: permission row 1 = open + requests.act open')

  // Deadline: an arrow key on the card pauses the countdown.
  await mode('deadline', 'deadline-hint')
  await app.getByTestId('question-panel').press('down')
  await app.getByTestId('acted-pause').waitFor({ timeoutMs: 5000 })
  await app.getByTestId('question-hold').click()
  await app.getByTestId('acted-hold').waitFor({ timeoutMs: 5000 })
  console.log('ok: deadline pauses on a key; Wait for me holds')

  // Records: the sign-in chip queues the request for the agent.
  await mode('records', 'records-fixture')
  await app.getByTestId('sign-in-chip-gh-fail').click()
  await app.getByTestId('queued').waitFor({ timeoutMs: 5000 })
  console.log('ok: sign-in chip queues its message')
} finally {
  await fixture.close()
  rmSync(scratch, { recursive: true, force: true })
}
