// Keys and decline notes of the request cards against the native fixture (all in memory): digits follow the visible order,
// ↑ ↓ Return act only with card focus, Esc cancels, the decline note rides the deny (Claude) or the next message (Codex).
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchFixture } from './harness.ts'

const out = process.env.KYBERN_VERIFY_OUTPUT ?? '/Users/mymac/projects/ade/.kybern-artifacts/ade-54-58/L4'
mkdirSync(out, { recursive: true })
const scratch = mkdtempSync(path.join(tmpdir(), 'gpuix-requests-keys-'))
const fixture = await launchFixture(path.join(import.meta.dir, 'parity.fixture.tsx'), {
  GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: 'dark', KYBERN_DATA_DIR: scratch, KYBERN_CLIENT_CONFIG_DIR: scratch, KYBERN_GPUIX_CREDENTIALS_DIR: scratch,
  KYBERN_URL: '', KYBERN_TOKEN: '', KYBERN_GPUIX_ENVIRONMENT: 'local', KYBERN_REDUCED_MOTION: '1', KYBERN_OPAQUE: '1',
})
const app = fixture.app
const has = async (testId: string) => (await app.getByTestId(testId).count()) > 0
const settle = () => app.clock.fastForward(300)
// The harness delivers a digit's text insertion after the composer's removal timer, so each case starts from an empty composer.
const mode = async (name: string) => { await app.getByTestId(`fixture-${name}`).click(); await app.getByTestId('approval-row-1').waitFor({ timeoutMs: 10000 }); await app.getByTestId('composer').fill(''); await settle() }
try {
  // 1. A digit in the empty composer picks that visible row: 2 is the session option.
  await mode('approval')
  await app.getByTestId('composer').press('2')
  await app.getByTestId('responded-allow_always').waitFor({ timeoutMs: 5000 })
  console.log('ok: digit 2 in the composer = session')

  // 2. Return in the composer never approves; Esc cancels the turn.
  await mode('command')
  await app.getByTestId('composer').press('enter')
  await settle()
  assert.ok(!(await has('responded-allow_once')), 'Return in the composer must not approve')
  await app.getByTestId('composer').press('escape')
  await app.getByTestId('rpc-threads.interrupt').waitFor({ timeoutMs: 5000 })
  console.log('ok: Return in the composer does nothing; Esc cancels the turn')

  // 3. On the card: ↓ ↓ moves to Decline, Return opens the note (it does not send), the note rides the deny.
  await mode('command')
  const card = app.getByTestId('approval-panel')
  await card.press('down'); await card.press('down')
  await settle()
  await card.press('enter')
  await app.getByTestId('approval-note').waitFor({ timeoutMs: 5000 })
  assert.ok(!(await has('rpc-approvals.respond')), 'Decline waits for the note')
  await app.getByTestId('approval-note').fill('Run only the date tests')
  await settle()
  await app.screenshot({ path: `${out}/after-decline-note-dark.png` })
  await app.getByTestId('approval-note').press('enter')
  await app.getByTestId('responded-deny:Run only the date tests').waitFor({ timeoutMs: 5000 })
  console.log('ok: decline note rides the deny reason (Claude)')

  // 4. Esc in the note goes back to the rows, and an empty note is a plain deny.
  await mode('command')
  await app.getByTestId('composer').press('3')
  await app.getByTestId('approval-note').waitFor({ timeoutMs: 5000 })
  await app.getByTestId('approval-note').press('escape')
  await settle()
  assert.ok(!(await has('approval-note')) && !(await has('rpc-approvals.respond')), 'Esc closes the note without sending')
  await app.getByTestId('approval-row-3').click()
  await app.getByTestId('approval-note').waitFor({ timeoutMs: 5000 })
  await app.getByTestId('approval-note').press('enter')
  await app.getByTestId('responded-deny').waitFor({ timeoutMs: 5000 })
  console.log('ok: Esc goes back; an empty note is a plain deny')

  // 5. Codex drops the reason, so the note goes as the next message.
  await mode('codex-command')
    await app.getByTestId('composer').press('3')
  await app.getByTestId('approval-note').waitFor({ timeoutMs: 5000 })
  await app.getByTestId('approval-note').fill('Use bun instead')
  await app.getByTestId('approval-note').press('enter')
  await app.getByTestId('responded-deny:Use bun instead').waitFor({ timeoutMs: 5000 })
  await app.getByTestId('queued-Use bun instead').waitFor({ timeoutMs: 5000 })
  console.log('ok: Codex note is sent as a follow-up message')

  // 6. The queue badge, and a connector's 1 is "once" now.
  await mode('queue')
  await app.getByText('1 of 3').waitFor({ timeoutMs: 5000 })
  assert.equal(await app.getByTestId('request-sliver').count(), 2)
  await app.getByTestId('fixture-connector').click()
  await app.getByTestId('approval-row-1').waitFor({ timeoutMs: 5000 })
  await app.getByTestId('composer').press('1')
  await app.getByTestId('responded-submit').waitFor({ timeoutMs: 5000 })
  console.log('ok: queue badge and slivers; connector 1 = once')

  // 7. A question: a digit picks, Return continues.
  await app.getByTestId('fixture-question').click()
  await app.getByTestId('question-next').waitFor({ timeoutMs: 5000 })
  await settle()
  await app.getByTestId('question-panel').press('2')
  await app.getByTestId('question-panel').press('enter')
  await settle()
  await app.getByText('Question 2 of 2').waitFor({ timeoutMs: 5000 })
  console.log('ok: question digit and Return')

  // 8. ⌘E expands a clamped chain (all 8 lines), and again collapses it; a short command has nothing to expand.
  await mode('long')
  assert.ok(await has('approval-expand'), 'a long chain clamps')
  await app.getByTestId('approval-panel').press('cmd-e')
  await settle()
  await app.screenshot({ path: `${out}/after-long-expanded-dark.png` })
  assert.equal(await app.getByTestId('approval-expand').count(), 1)
  assert.ok((await app.call('getPaintedText', {})).text.join('\n').includes('Show less'), '⌘E expands the well')
  await app.getByTestId('approval-panel').press('cmd-e')
  await settle()
  assert.ok((await app.call('getPaintedText', {})).text.join('\n').includes('Show all 8 lines'), '⌘E collapses it again')
  console.log('ok: ⌘E expands and collapses the long chain')
} finally { console.log(fixture.diagnostics().slice(-400)); await fixture.close(); rmSync(scratch, { recursive: true, force: true }) }
