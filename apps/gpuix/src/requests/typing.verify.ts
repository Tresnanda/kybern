// The typing guard against its native fixture (all in memory): a question that arrives while the reader types waits behind a
// hint, opens after ~1.5 s of quiet or at once on Esc, and the typed text is back in the composer after the answer; a password
// prompt waits too but ignores Esc. Screenshots go to `KYBERN_VERIFY_OUTPUT`.
// `bun src/requests/typing.verify.ts` with `NAPI_RS_NATIVE_LIBRARY_PATH` set to a patched addon.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchFixture } from './harness.ts'

const out = process.env.KYBERN_VERIFY_OUTPUT ?? '/Users/mymac/projects/ade/.kybern-artifacts/ade-69-71/L-typing'
mkdirSync(out, { recursive: true })
const theme = process.env.TYPING_THEME ?? 'dark'
const scratch = mkdtempSync(path.join(tmpdir(), 'gpuix-typing-verify-'))
const fixture = await launchFixture(path.join(import.meta.dir, 'typing.fixture.tsx'), {
  GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: theme, KYBERN_DATA_DIR: scratch, KYBERN_CLIENT_CONFIG_DIR: scratch, KYBERN_GPUIX_CREDENTIALS_DIR: scratch,
  KYBERN_URL: '', KYBERN_TOKEN: '', KYBERN_GPUIX_ENVIRONMENT: 'local', KYBERN_REDUCED_MOTION: '1', KYBERN_OPAQUE: '1',
})
const app = fixture.app
const count = (testId: string) => app.getByTestId(testId).count()
async function until(check: () => Promise<boolean>, what: string, tries = 120) { for (let i = 0; i < tries; i++) { try { if (await check()) return } catch { /* not there yet */ } await Bun.sleep(50) } throw Error(`Timed out: ${what}`) }
const text = (testId: string) => app.getByTestId(testId).textContent()
const painted = async () => String((await app.call('getPaintedText', {})).text)
const DRAFT = 'Can you also check the dock tabs when'
try {
  await app.getByTestId('composer').waitFor({ timeoutMs: 10000 })
  await until(async () => (await text('blocking')) === 'no', 'ready')

  // 1. Typing, then a question arrives: the composer stays, the hint stands in for the card.
  await app.getByTestId('composer').fill(DRAFT)
  await app.getByTestId('arrive-question').click()
  await until(async () => (await count('typing-hint')) > 0, 'hint')
  assert.equal(await count('question-panel'), 0, 'the card waits while the reader types')
  assert.equal(await text('blocking'), 'no', 'the composer is still there')
  assert.ok((await painted()).includes(DRAFT), 'the draft is untouched')
  assert.deepEqual((await text('acted')).split(','), ['pause'], 'the deadline is paused while the card is unseen')
  await Bun.sleep(300)
  await app.screenshot({ path: `${out}/after-hint-${theme}.png` })
  console.log('ok: question held behind the hint; draft kept; deadline paused')

  // 2. A keystroke inside the window pushes the opening back; after ~1.5 s of quiet the card opens in the composer's place.
  await Bun.sleep(900)
  await app.getByTestId('composer').fill(`${DRAFT} I`)
  await Bun.sleep(900)
  assert.equal(await count('question-panel'), 0, 'a new keystroke starts the window over')
  await until(async () => (await count('question-panel')) > 0, 'card after the pause', 80)
  await until(async () => (await text('blocking')) === 'yes', 'composer replaced')
  assert.equal(await count('typing-hint'), 0, 'the hint is gone')
  await until(async () => (await text('acted')).endsWith('resume'), 'deadline resumed')
  await app.screenshot({ path: `${out}/after-card-${theme}.png` })
  console.log('ok: card opens after the pause and the deadline resumes')

  // 3. Answering brings the composer back with the typed text.
  await app.getByTestId('answer').click()
  await until(async () => (await text('blocking')) === 'no', 'composer back')
  await until(async () => (await painted()).includes(`${DRAFT} I`), 'draft restored')
  await app.screenshot({ path: `${out}/after-restored-${theme}.png` })
  console.log('ok: typed text is back in the composer after the answer')

  // 4. Esc in the composer opens a held card at once.
  await app.getByTestId('composer').fill(`${DRAFT} II`)
  await app.getByTestId('arrive-question').click()
  await until(async () => (await count('typing-hint')) > 0, 'hint again')
  await app.getByTestId('composer').press('escape')
  await until(async () => (await count('question-panel')) > 0, 'Esc opens the card')
  await app.getByTestId('answer').click()
  await until(async () => (await painted()).includes(`${DRAFT} II`), 'draft restored after Esc')
  console.log('ok: Esc opens the card at once; draft restored')

  // 5. A click on the hint opens it too.
  await app.getByTestId('composer').fill(`${DRAFT} III`)
  await app.getByTestId('arrive-question').click()
  await until(async () => (await count('typing-hint')) > 0, 'hint for the click')
  await app.getByTestId('typing-hint').click()
  await until(async () => (await count('question-panel')) > 0, 'click opens the card')
  await app.getByTestId('answer').click()
  await until(async () => (await painted()).includes(`${DRAFT} III`), 'draft restored after the click')
  console.log('ok: a click on the hint opens the card')

  // 6. A password prompt waits too, ignores Esc, and takes no focus from the text that was typed.
  await app.getByTestId('composer').fill(`${DRAFT} IV`)
  await app.getByTestId('arrive-password').click()
  await until(async () => (await count('typing-hint')) > 0, 'hint for the password')
  await Bun.sleep(300)
  await app.screenshot({ path: `${out}/after-password-hint-${theme}.png` })
  await app.getByTestId('composer').press('escape')
  await Bun.sleep(300)
  assert.equal(await count('prompt-panel'), 0, 'Esc never opens a password prompt')
  await until(async () => (await count('prompt-panel')) > 0, 'password opens on the pause', 80)
  await app.screenshot({ path: `${out}/after-password-card-${theme}.png` })
  console.log('ok: the password prompt ignores Esc and opens on the pause')
  await app.getByTestId('answer').click()
  await until(async () => (await painted()).includes(`${DRAFT} IV`), 'draft restored after the password')

  // 7. Nothing typed recently: a card opens at once.
  await app.getByTestId('composer').fill('')
  await Bun.sleep(1700)
  await app.getByTestId('arrive-question').click()
  await until(async () => (await count('question-panel')) > 0, 'card at once when idle', 20)
  assert.equal(await count('typing-hint'), 0)
  console.log('ok: an idle composer gets the card at once')
} finally {
  await fixture.close()
  rmSync(scratch, { recursive: true, force: true })
}
process.exit(0)
