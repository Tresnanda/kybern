import { screens as conversationScreens } from './conversation.tauri.mjs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
const park = p => p.mouse.move(1275, 815)
async function open(p, title) {
  await p.exposeFunction('__fixtureQr', invitation => execFileSync('bun', ['-e', "import {pairingQrSvg} from './src/environments/qr.ts'; console.log(pairingQrSvg(process.argv[1]))", invitation], { cwd: path.resolve(import.meta.dirname, '../..'), encoding: 'utf8' }).trim())
  // Mark native availability after boot; only the host suggestions bridge is mocked.
  await p.evaluate(async () => {
    window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
      if (command === 'remote_ssh_hosts') return []
      if (command === 'pairing_qr') return window.__fixtureQr(args.invitation)
      return null
    } }
    const { useEnvironments } = await import('/src/state/environments.ts')
    useEnvironments.setState({ profiles: [{ id: 'local', name: 'Development environment', local: true, hostname: 'Managed by Kybern' }], selectedId: 'local' })
  })
  await p.getByRole('button', { name: 'Switch environment', exact: true }).click()
  await p.getByRole('menuitem', { name: title, exact: true }).click()
  await p.getByRole('heading', { name: title, exact: true }).waitFor()
}
export const screens = {
  'environment-add-ssh': async p => { await open(p, 'Add environment'); await park(p) },
  'environment-add-address': async p => { await open(p, 'Add environment'); await p.getByRole('tab', { name: 'Address or invitation' }).click(); await park(p) },
  'environment-manage': async p => { await open(p, 'Manage environments'); await park(p) },
  'environment-pair-empty': async p => { await open(p, 'Pair a device'); await p.getByText('Reachable over Tailscale', {exact:true}).waitFor(); await park(p) },
  'environment-pair-invitation': async p => { await open(p, 'Pair a device'); await p.getByRole('button', {name:'Create pairing invitation',exact:true}).click(); await p.getByRole('textbox', {name:'Connection address'}).fill('http://192.0.2.10:4219'); await p.getByRole('img', {name:'Pairing QR code'}).waitFor(); await park(p) },
}

screens['composer-uploaded-images'] = async p => { await conversationScreens['conversation-transcript'](p); if (!await p.getByText('Empty conversation',{exact:true}).count()) await p.getByText(/^Show \d+ more$/).first().click(); await p.getByText('Empty conversation',{exact:true}).first().click(); await p.getByText('Clipboard upload fixture',{exact:true}).waitFor(); await p.locator('img').first().waitFor(); await p.waitForTimeout(300); await park(p) }

for (const [name,label] of [['composer-home-workspace','Choose where the thread runs'],['composer-home-branch','Choose a branch']]) screens[name] = async p => { await p.getByRole('button',{name:label,exact:true}).click(); await p.getByRole('menu').waitFor(); await park(p) }
