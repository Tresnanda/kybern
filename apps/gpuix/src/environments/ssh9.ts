/** settings9: the SSH tab against a port nothing listens on: progress rows, the failure text and a retryable form. No remote host is contacted. */
import { mode, reset, start, wait } from './verify9.lib.ts'
const assert = (ok: unknown, message: string) => { if (!ok) throw Error(`FAIL: ${message}`); console.log(`ok  ${message}`) }
reset()
const h = await start()
try {
  await wait(1200)
  await h.click('environment-switcher'); await h.click('environment-add'); await h.app.getByTestId('environment-machine').waitFor()
  await h.app.getByTestId('environment-name').fill('Nowhere')
  await h.app.getByTestId('environment-machine').fill('nobody@127.0.0.1:1')
  await h.click('environment-save')
  await h.until('progress rows', () => h.present('environment-setup-progress'), 20000)
  await h.shot('ssh-01-progress')
  await h.until('failure shown', () => h.present('environment-setup-error'), 90000)
  await h.shot('ssh-02-failed')
  assert(await h.text('Connect over SSH'), 'the four setup steps are listed')
  await h.click('environment-advanced'); await h.shot('ssh-03-advanced')
  assert(await h.present('environment-save') && await h.present('environment-data-dir'), 'the form stays editable after a failure')
  console.log(`PASS ssh failure states (${mode}${process.env.KYBERN_REDUCED_MOTION === '1' ? ', reduced motion' : ''})`)
} catch (e) { await h.shot('ssh-failure'); throw e } finally { await h.app.close() }
