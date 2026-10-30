// ADE-100: real native sidebar/broker/provision consumers and authenticated loopback fixture sockets.
// Run membership.check.ts; all files and credentials stay in the runner's scratch directory.
import '../native/local-build.ts'
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { render } from '@gpuix/react'
import { PROTOCOL_VERSION, type MachineCard, type NetworkStatus } from '../../../../packages/kybern-client/src/types.ts'
import { connect, useApp } from '../state.ts'
import { Label, ThemeProvider, useTheme } from '../ui.tsx'
import { Button } from '../kit/Button.tsx'
import { onWindowKeyDown } from '../nav/keys.ts'
import { MachineFilter } from '../sidebar/MachineFilter.tsx'
import { LoginBrokerSection } from '../settings/LoginBroker.tsx'
import { provisionContextOf } from '../provision/targets.ts'
import { machineHub, useMachines } from './index.ts'
import { setNetworkEnabled, useNetwork } from './network.ts'
import { writeMachineRecords } from './store.ts'
import { writeCredential } from '../environments/credentials.ts'

for (const key of ['KYBERN_DATA_DIR', 'KYBERN_CLIENT_CONFIG_DIR', 'KYBERN_GPUIX_CREDENTIALS_DIR']) {
  if (!process.env[key]) throw Error(`Membership fixture requires ${key}`)
}
const ids = ['mac', 'kdi', 'instabox', 'satya', 'later']
const names = ['MacBook Pro', 'os-kdi', 'instabox', 'SatyaMas', 'Later machine']
const keys = ids.map(() => generateKeyPairSync('ed25519'))
const cards = ids.map((machine_id, i): MachineCard => ({ machine_id, name: names[i]!, os: i === 3 ? 'windows' : 'linux',
  is_self: i === 0, status: 'online', features: ['network.v1', 'login.broker.v1'],
  signing_key: keys[i]!.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'),
} as MachineCard))
let enabled = false
let joined = false
let removed = false
let brokerChanges = 0
const members = () => cards.filter((card) => (card.machine_id !== 'later' || joined) && (card.machine_id !== 'satya' || !removed))
const network = (id: string): NetworkStatus => ({ enabled, removed: false, self_machine: cards.find((c) => c.machine_id === id)!, members: members(), found: [], broker: null, outbox: { queued: 0, failed: 0 }, tailscale: { installed: true, running: true } } as NetworkStatus)
const project = { id: 'fixture-project', name: 'Kybern fixture', path: '/fixture/project', is_git: true, repo: { root_commit: 'fixture-root' }, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' }
const server = Bun.serve<{ id: string }>({ port: 0, hostname: '127.0.0.1', fetch(req, s) {
  const url = new URL(req.url)
  const id = url.pathname.split('/')[1] || 'mac'
  if (url.pathname.endsWith('/ws') && s.upgrade(req, { data: { id } })) return
  const index = ids.indexOf(id)
  if (index >= 0 && url.pathname.endsWith('/.well-known/kybern/machine')) {
    const at = new Date().toISOString(), nonce = url.searchParams.get('nonce') ?? ''
    const message = Buffer.from(`kybern-wk-v1\0${nonce}${id}${at}${url.host}`)
    return Response.json({ machine_id: id, name: names[index], os: cards[index]!.os, signing_key: cards[index]!.signing_key, at, proof: sign(null, message, keys[index]!.privateKey).toString('base64') })
  }
  return new Response('Membership fixture')
}, websocket: {
  open(ws) { ws.subscribe('network') },
  message(ws, raw) {
    const request = JSON.parse(String(raw)), id = ws.data.id
    let result: unknown = {}
    switch (request.method) {
      case 'daemon.info': result = { protocol_version: PROTOCOL_VERSION, environment_id: id, machine_id: id, hostname: names[ids.indexOf(id)], version: '0.20.0', features: ['network.v1', 'login.broker.v1'] }; break
      case 'projects.list': result = { projects: id === 'mac' ? [project] : [] }; break
      case 'threads.list': result = { threads: [] }; break
      case 'tasks.list': result = { tasks: [] }; break
      case 'events.subscribe': result = { subscription_id: `fixture-${id}`, head_seq: 0, replay_ready: true }; break
      case 'network.status': result = network(id); break
      case 'network.set_enabled': enabled = !!request.params.enabled; break
      case 'network.routes': result = { routes: [route(request.params.machine_id)] }; break
      case 'network.client_grant': result = { token: 'fixture', scopes: [], routes: [route(request.params.machine_id)], signing_key: cards.find((c) => c.machine_id === request.params.machine_id)?.signing_key }; break
      case 'outbox.list': result = { items: [] }; break
      case 'login.broker.status': result = { broker: null, is_broker: false, providers: [], loans: [] }; break
      case 'login.broker.set': brokerChanges++; break
    }
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }))
    if (request.method === 'network.set_enabled') notify()
  },
} })
const route = (id: string) => ({ kind: 'direct_advertised' as const, url: `http://127.0.0.1:${server.port}/${id}` })
const notify = () => server.publish('network', JSON.stringify({ jsonrpc: '2.0', method: 'network.changed', params: {} }))
const config = process.env.KYBERN_CLIENT_CONFIG_DIR!
mkdirSync(config, { recursive: true })
writeMachineRecords(config, cards.slice(0, 3).map((card) => ({ machineId: card.machine_id, name: card.name, member: false, routes: [route(card.machine_id)], legacyProfileId: card.machine_id === 'mac' ? 'local' : card.machine_id })))
for (const id of ids.slice(0, 3)) await writeCredential(`machine:${id}`, 'fixture')
process.env.KYBERN_URL = `${route('mac').url.replace('http', 'ws')}/ws`
process.env.KYBERN_TOKEN = 'fixture'
await connect()

function Fixture() {
  const t = useTheme(), machines = useMachines(), net = useNetwork()
  const loaded = useApp((s) => s.listsLoaded)
  const context = loaded ? provisionContextOf(project.id, 'mac') : null
  return <div testId="fixture-ready" style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', backgroundColor: t.surface, padding: 24, gap: 20 }}>
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <Button testId="fixture-enable" busy={net.busy !== null} onClick={() => void setNetworkEnabled(!net.status?.enabled)}>{net.status?.enabled ? 'Disable network' : 'Enable network'}</Button>
      <Button testId="fixture-join" onClick={() => { joined = true; notify() }}>Join later machine</Button>
      <Button testId="fixture-remove" onClick={() => { removed = true; notify() }}>Remove SatyaMas</Button>
    </div>
    <div style={{ width: 304 }}><MachineFilter /></div>
    <LoginBrokerSection />
    <div testId="fixture-members"><Label color={t.text}>{`Members: ${machines.filter((m) => m.member).map((m) => m.name).join(', ')}`}</Label></div>
    <div testId="fixture-targets"><Label color={t.text}>{`Provision: ${context?.targets.map((m) => m.machineName).join(', ') ?? ''}`}</Label></div>
    <div testId="fixture-broker-changes"><Label color={t.text}>{`Broker changes: ${brokerChanges}`}</Label></div>
  </div>
}
render(<ThemeProvider><Fixture /></ThemeProvider>, { title: 'Membership refresh', width: Number(process.env.MEMBERSHIP_WIDTH ?? 1000), height: 700, focus: false, onKeyDown: onWindowKeyDown })
const close = () => { machineHub().dispose(); server.stop(true); process.exit(0) }
process.stdin.on('end', close)
process.stdin.on('close', close)
