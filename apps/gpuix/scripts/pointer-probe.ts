import path from 'node:path'
import { launch } from '@gpuix/react/automation'
import { CLIENT_DIR, CREDS_DIR, DATA_DIR } from '../visual/fixture.ts'
const app = await launch({ command: 'bun', args: [path.resolve(import.meta.dir, '../src/main.tsx')], env: { GPUIX_BACKGROUND: '1', KYBERN_DATA_DIR: DATA_DIR, KYBERN_CLIENT_CONFIG_DIR: CLIENT_DIR, KYBERN_GPUIX_CREDENTIALS_DIR: CREDS_DIR, KYBERN_GPUIX_THREAD: 'Date helper cleanup' } })
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const has = async (id: string) => (await app.getByTestId(id).count()) > 0
try {
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 60000 }); await wait(2500)
  const sep = async (id: string) => { const at = await app.getByTestId(id).center(); await app.mouse.down(at); await wait(60); await app.mouse.up(at); await wait(500) }
  await sep('dock-toggle'); console.log('dock-toggle (title bar button) -> right-dock', await has('right-dock'))
  await sep('dock-toggle'); await wait(500)
  await sep('sidebar-toggle'); await wait(500); console.log('sidebar toggled, sidebar visible?', await has('sidebar-toggle'))
  await sep('sidebar-toggle')
  await sep('composer-plus'); console.log('composer-plus ->', await has('composer-plus-menu'))
  await app.mouse.click(await app.getByTestId('composer-plus').center()); await wait(500); console.log('composer-plus single click ->', await has('composer-plus-menu'))
} finally { await app.close() }
process.exit(0)
