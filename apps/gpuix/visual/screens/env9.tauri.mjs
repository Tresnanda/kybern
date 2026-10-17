// settings9: environment surfaces with three saved environments, in the desktop frontend (WebKit).
import { execFileSync } from 'node:child_process'
import path from 'node:path'
const park = p => p.mouse.move(1275, 815)
export const PROFILES = [
  { id: 'local', name: 'Development environment', local: true, hostname: 'Managed by Kybern' },
  { id: 'second', name: 'Second machine', url: 'ws://127.0.0.1:4295/ws', environment_id: 'env-second', hostname: 'MacBookPro', local: false },
  { id: 'build', name: 'Build server', url: 'ws://127.0.0.1:4310/ws', environment_id: 'env-build', local: false, ssh: { target: 'dev@build.example.com', port: 2222, remote_port: 4173, local_port: 4310 } },
]
async function prepare(p) {
  await p.exposeFunction('__fixtureQr', invitation => execFileSync('bun', ['-e', "import {pairingQrSvg} from './src/environments/qr.ts'; console.log(pairingQrSvg(process.argv[1]))", invitation], { cwd: path.resolve(import.meta.dirname, '../..'), encoding: 'utf8' }).trim())
  await p.evaluate(async (profiles) => {
    window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
      if (command === 'remote_ssh_hosts') return []
      if (command === 'pairing_qr') return window.__fixtureQr(args.invitation)
      return null
    } }
    const { useEnvironments } = await import('/src/state/environments.ts')
    useEnvironments.setState({ profiles, selectedId: 'local' })
  }, PROFILES)
}
async function open(p, title) {
  await prepare(p)
  await p.getByRole('button', { name: 'Switch environment', exact: true }).click()
  await p.getByRole('menuitem', { name: title, exact: true }).click()
  await p.getByRole('heading', { name: title, exact: true }).waitFor()
}
const mode = async (p, value) => { const ws = new URL(new URL(p.url()).searchParams.get('url')); await p.request.get(`http://${ws.host}/mode?value=${value}`) }
const address = async p => { await open(p, 'Add environment'); await p.getByRole('tab', { name: 'Address or invitation' }).click() }
export const screens = {
  'env9-menu': async p => { await prepare(p); await p.getByRole('button', { name: 'Switch environment', exact: true }).click(); await p.getByRole('menu').waitFor(); await park(p) },
  'env9-manage': async p => { await open(p, 'Manage environments'); await park(p) },
  'env9-edit-address': async p => { await open(p, 'Manage environments'); await p.getByRole('button', { name: 'Edit Second machine' }).click(); await p.getByRole('heading', { name: 'Edit environment' }).waitFor(); await park(p) },
  'env9-edit-ssh': async p => { await open(p, 'Manage environments'); await p.getByRole('button', { name: 'Edit Build server' }).click(); await p.getByRole('heading', { name: 'Edit environment' }).waitFor(); await park(p) },
  'env9-add-invitation': async p => { await address(p); await p.getByRole('textbox', { name: 'Address or pairing invitation' }).fill('kybern://pair?url=ws%3A%2F%2F127.0.0.1%3A4295%2Fws&code=123456&environment=env-second'); await p.getByRole('textbox', { name: 'Name' }).fill('Studio Mac'); await park(p) },
  'env9-add-invalid': async p => { await address(p); await p.getByRole('textbox', { name: 'Name' }).fill('Studio Mac'); await p.getByRole('textbox', { name: 'Address or pairing invitation' }).fill('not a url'); await p.getByRole('textbox', { name: 'Name' }).click(); await p.waitForTimeout(300); await park(p) },
  'env9-add-ssh-filled': async p => { await open(p, 'Add environment'); await p.getByRole('textbox', { name: 'Name' }).fill('Dev server'); await p.getByLabel('SSH machine').fill('dev@devbox.example.com'); await p.getByText('Advanced', { exact: true }).click(); await park(p) },
  'env9-pair-devices': async p => { await mode(p, 'devices'); await open(p, 'Pair a device'); await p.getByText('Pixel tablet', { exact: true }).waitFor(); await park(p) },
  'env9-pair-devices-invitation': async p => { await mode(p, 'devices'); await open(p, 'Pair a device'); await p.getByText('Pixel tablet', { exact: true }).waitFor(); await p.getByRole('button', { name: 'Create pairing invitation', exact: true }).click(); await p.getByRole('textbox', { name: 'Connection address' }).fill('https://studio.tailnet.ts.net'); await p.getByRole('img', { name: 'Pairing QR code' }).waitFor(); await park(p) },
}
