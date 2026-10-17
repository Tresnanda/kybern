// settings9: environment surfaces with three saved environments, in GPUIX. The registry is written after launch (the harness clears it per screen).
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { type Step, park, settle } from '../screens.gpuix.ts'
import { CLIENT_DIR } from '../fixture.ts'
import { pointer } from './composer.gpuix.ts'
const PROFILES = [
  { id: 'second', name: 'Second machine', url: 'ws://127.0.0.1:4295/ws', environment_id: 'env-second', hostname: 'MacBookPro', local: false },
  { id: 'build', name: 'Build server', url: 'ws://127.0.0.1:4310/ws', environment_id: 'env-build', local: false, ssh: { target: 'dev@build.example.com', port: 2222, remote_port: 4173, local_port: 4310 } },
]
const seedRegistry = () => { mkdirSync(CLIENT_DIR, { recursive: true }); writeFileSync(path.join(CLIENT_DIR, 'environments.json'), JSON.stringify({ selected_id: 'local', environments: PROFILES })) }
const mode = async (fx: Parameters<Step>[1], value: string) => { await fetch(`http://127.0.0.1:${fx.extra.settings!.port}/mode?value=${value}`) }
const open = async (app: Parameters<Step>[0], kind: string, ready: string) => { seedRegistry(); await pointer(app, 'environment-switcher'); await pointer(app, `environment-${kind}`); await app.getByTestId(ready).waitFor({ timeoutMs: 15000 }) }
const address: Step = async app => { await open(app, 'add', 'environment-machine'); await pointer(app, 'environment-tab-address'); await app.getByTestId('environment-address').waitFor() }
const fill = (app: Parameters<Step>[0], id: string, value: string) => app.getByTestId(id).fill(value)
export const screens: Record<string, Step> = {
  'env9-menu': async app => { seedRegistry(); await pointer(app, 'environment-switcher'); await app.getByTestId('environment-switcher-menu').waitFor(); await settle(); await park(app) },
  'env9-manage': async app => { await open(app, 'manage', 'environment-manage-list'); await park(app) },
  'env9-edit-address': async app => { await open(app, 'manage', 'environment-manage-list'); await pointer(app, 'environment-edit-second'); await app.getByTestId('environment-address').waitFor(); await park(app) },
  'env9-edit-ssh': async app => { await open(app, 'manage', 'environment-manage-list'); await pointer(app, 'environment-edit-build'); await app.getByTestId('environment-machine').waitFor(); await park(app) },
  'env9-add-invitation': async (app, fx) => { await address(app, fx); await fill(app, 'environment-address', 'kybern://pair?url=ws%3A%2F%2F127.0.0.1%3A4295%2Fws&code=123456&environment=env-second'); await fill(app, 'environment-name', 'Studio Mac'); await park(app) },
  'env9-add-invalid': async (app, fx) => { await address(app, fx); await fill(app, 'environment-name', 'Studio Mac'); await fill(app, 'environment-address', 'not a url'); await pointer(app, 'environment-name'); await settle(); await park(app) },
  'env9-add-ssh-filled': async app => { await open(app, 'add', 'environment-machine'); await fill(app, 'environment-name', 'Dev server'); await fill(app, 'environment-machine', 'dev@devbox.example.com'); await pointer(app, 'environment-advanced'); await park(app) },
  'env9-pair-devices': async (app, fx) => { await mode(fx, 'devices'); await open(app, 'pair', 'pairing-create'); await settle(); await park(app) },
  'env9-pair-devices-invitation': async (app, fx) => { await mode(fx, 'devices'); await open(app, 'pair', 'pairing-create'); await pointer(app, 'pairing-create'); await app.getByTestId('pairing-address').waitFor(); await fill(app, 'pairing-address', 'https://studio.tailnet.ts.net'); await app.getByTestId('pairing-qr').waitFor(); await park(app) },
}
