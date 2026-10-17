// polish9: the SSH setup dialog while it works, to see the shared ring spinner in the button and in the progress list.
//   bun src/environments/polish9-busy.ts [dark|light]   (same KYBERN_VERIFY9_* scratch env as verify9.ts)
import { mode, start, wait } from './verify9.lib.ts'

const { app, until, click, shot } = await start()
try {
  await wait(1200)
  await click('environment-switcher'); await click('environment-add'); await app.getByTestId('environment-machine').waitFor()
  await app.getByTestId('environment-name').fill('Busy check'); await app.getByTestId('environment-machine').fill('nobody@192.0.2.1')
  await click('environment-save')
  await until('progress list', async () => (await app.getByTestId('environment-setup-progress').count()) > 0, 20000)
  await wait(400); await shot('busy-ssh')
  await shot('busy-ssh-b')
  console.log(`busy dialog captured (${mode})`)
} finally { await app.close() }
