// remote9: SSH setup states in GPUIX, driven by a no-network `ssh` (`remote9-ssh.sh`). Pairs with `remote9.tauri.mjs`.
import path from 'node:path'
import { type Step, park, settle } from '../screens.gpuix.ts'
import { pointer } from './composer.gpuix.ts'
const fake = { KYBERN_SSH: path.join(import.meta.dir, 'remote9-ssh.sh'), KYBERN_SSH_CONFIG: '/nonexistent' }
export const entries = { 'r9-ssh-progress': { env: fake }, 'r9-ssh-permission': { env: fake }, 'r9-ssh-unreachable': { env: fake } }
const setup = (machine: string, ready: (app: Parameters<Step>[0]) => Promise<void>): Step => async app => {
  await pointer(app, 'environment-switcher'); await pointer(app, 'environment-add'); await app.getByTestId('environment-machine').waitFor({ timeoutMs: 15000 })
  await app.getByTestId('environment-name').fill('Dev server'); await app.getByTestId('environment-machine').fill(machine)
  await pointer(app, 'environment-save'); await ready(app); await settle(400); await park(app)
}
const until = async (check: () => Promise<boolean>) => { const end = Date.now() + 20000; while (Date.now() < end) { if (await check()) return; await settle(100) } throw Error('state not reached') }
const text = (app: Parameters<Step>[0], value: string) => async () => JSON.stringify(await app.call('getPaintedText', {})).includes(value)
export const screens: Record<string, Step> = {
  'r9-ssh-progress': setup('dev@slow.example', app => until(text(app, 'kybernd 0.9.1 is installed'))),
  'r9-ssh-permission': setup('dev@perm.example', app => app.getByTestId('environment-setup-error').waitFor({ timeoutMs: 20000 })),
  'r9-ssh-unreachable': setup('dev@closed.example', app => app.getByTestId('environment-setup-error').waitFor({ timeoutMs: 20000 })),
}
