import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { launchFixture, waitForPainted } from '../requests/harness.ts'
const out = path.resolve(process.env.KYBERN_VERIFY_OUTPUT!)
mkdirSync(out, {recursive:true})
for (const appearance of ['dark','light']) {
  const scratch = path.join(out, 'scratch-'+appearance)
  const f = await launchFixture(path.join(import.meta.dir,'native-commands.fixture.tsx'), {
    GPUIX_BACKGROUND:'1', KYBERN_APPEARANCE:appearance, KYBERN_DATA_DIR:scratch,
    KYBERN_CLIENT_CONFIG_DIR:scratch, KYBERN_GPUIX_CREDENTIALS_DIR:scratch, KYBERN_URL:'', KYBERN_TOKEN:'',
  })
  try {
    await f.app.getByTestId('fixture-ready').waitFor({timeoutMs:60000})
    await waitForPainted(f.app, 'Account usage')
    await Bun.sleep(700)
    await f.app.screenshot({path:path.join(out,`usage-${appearance}.png`)})
    await f.app.getByTestId('composer').fill('/')
    await waitForPainted(f.app, 'omp:usage')
    await f.app.screenshot({path:path.join(out,`menu-${appearance}.png`)})
  } finally { await f.close() }
}
