import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { launchFixture } from '../requests/harness.ts'
const scratch = mkdtempSync(tmpdir() + '/gpuix-probe-')
const f = await launchFixture(import.meta.dir + '/conversation.fixture.tsx', { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: 'dark', KYBERN_DATA_DIR: scratch, KYBERN_CLIENT_CONFIG_DIR: scratch, KYBERN_GPUIX_CREDENTIALS_DIR: scratch, KYBERN_GPUIX_ENVIRONMENT: 'local', KYBERN_URL: '', KYBERN_TOKEN: '' })
const app = f.app
await app.getByTestId('conversation-ready').waitFor()
await Bun.sleep(1500)
await app.getByTestId('composer').fill('@KYB-1')
await Bun.sleep(1200)
console.log('BEFORE', (await app.call('getPaintedText', {})).text.slice(-300))
await app.getByTestId('composer').press('enter')
await Bun.sleep(1200)
console.log('AFTER', (await app.call('getPaintedText', {})).text.slice(-400))
console.log('TEXT', JSON.stringify(await app.getByTestId('composer').textContent()))
await app.getByTestId('composer').press('cmd-z'); await Bun.sleep(800)
console.log('UNDO', JSON.stringify(await app.getByTestId('composer').textContent()))
await f.close()
process.exit(0)
