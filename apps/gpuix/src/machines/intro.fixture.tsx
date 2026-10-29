// Deterministic native fixture for the machine network's intro and Settings → Machines while the network is off. No real
// daemon or machine is touched: an in-process socket answers every call. Drive it with `intro.shots.ts`.
import '../native/local-build.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { render } from '@gpuix/react'
import { useState } from 'react'
import { PROTOCOL_VERSION, type MachineCard, type NetworkStatus } from '../../../../packages/kybern-client/src/types.ts'
import { connect, set, useApp } from '../state.ts'
import { ThemeProvider, useTheme } from '../ui.tsx'
import { Button } from '../kit/Button.tsx'
import { onWindowKeyDown } from '../nav/keys.ts'
import { Machines } from '../settings/Machines.tsx'
import { NetworkIntroSurface } from './NetworkIntro.tsx'
import { openIntro } from './intro.ts'
import { refreshNetwork } from './network.ts'

const card = (machine_id: string, name: string, os: string, self = false): MachineCard => ({ machine_id, name, os, status: 'online', is_self: self, version: '0.19.0' } as MachineCard)
const SELF = card('intro-fixture-mac', 'MacBook Pro', 'macos', true)
let enabled = false
let tailscale = { installed: true, running: true }
let members: MachineCard[] = [SELF]
const status = (): NetworkStatus => ({ enabled, self_machine: SELF, members: enabled ? members : [SELF], found: [], outbox: { queued: 0, failed: 0 }, tailscale } as NetworkStatus)

const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(req, s) { if (s.upgrade(req)) return; return new Response('fixture') }, websocket: { message(ws, raw) {
  const request = JSON.parse(String(raw)); let result: unknown = {}
  switch (request.method) {
    case 'daemon.info': result = { protocol_version: PROTOCOL_VERSION, environment_id: SELF.machine_id, machine_id: SELF.machine_id, hostname: 'MacBook Pro', version: '0.19.0', features: ['network.v1'] }; break
    case 'projects.list': result = { projects: [] }; break
    case 'threads.list': result = { threads: [] }; break
    case 'tasks.list': result = { tasks: [] }; break
    case 'events.subscribe': result = { subscription_id: 'fixture', head_seq: 0, replay_ready: true }; break
    case 'network.status': result = status(); break
    case 'network.set_enabled': enabled = !!request.params?.enabled; result = status(); break
    case 'outbox.list': result = { items: [] }; break
    case 'machines.info': result = { machine_id: SELF.machine_id, name: SELF.name, os: 'macos', harnesses: [] }; break
  }
  setTimeout(() => ws.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result })), request.method === 'network.set_enabled' ? 500 : 20)
  set({ statusDetail: `${request.method}:${Date.now()}` })
} } })
process.env.KYBERN_URL = `ws://127.0.0.1:${server.port}/ws`
process.env.KYBERN_TOKEN = 'fixture'
if (!process.env.KYBERN_DATA_DIR) throw Error('Fixture requires an isolated data directory')
mkdirSync(process.env.KYBERN_DATA_DIR, { recursive: true })
writeFileSync(path.join(process.env.KYBERN_DATA_DIR, 'daemon.port'), String(server.port))
writeFileSync(path.join(process.env.KYBERN_DATA_DIR, 'daemon.token'), 'fixture', { mode: 0o600 })
connect()

/** Each mode sets what the daemon answers, then opens the surface it shows. */
const MODES: Record<string, () => void> = {
  intro: () => { enabled = false; tailscale = { installed: true, running: true }; openIntro(false) },
  'intro-stopped': () => { enabled = false; tailscale = { installed: true, running: false }; openIntro(false) },
  'intro-missing': () => { enabled = false; tailscale = { installed: false, running: false }; openIntro(false) },
  on: () => { enabled = true; members = [SELF]; openIntro(false, 'on') },
  'on-joined': () => { enabled = true; members = [SELF, card('intro-fixture-win', 'Windows PC', 'windows'), card('intro-fixture-kdi', 'os-kdi', 'linux')]; openIntro(false, 'on') },
  settings: () => { enabled = false; tailscale = { installed: true, running: true } },
  'settings-missing': () => { enabled = false; tailscale = { installed: false, running: false } },
  'settings-on': () => { enabled = true; members = [SELF]; tailscale = { installed: true, running: true } },
}

function Fixture() {
  useApp((s) => s.statusDetail)
  const t = useTheme()
  const [selected, choose] = useState('settings')
  // Opened a beat after the press, so the press that chose the mode is not taken as a press outside the dialog.
  const pick = (name: string) => { choose(name); void refreshNetwork(); setTimeout(() => { MODES[name]!(); void refreshNetwork() }, 250) }
  return <div testId="fixture-ready" style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', position: 'relative', backgroundColor: t.surface }}>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: 14 }}>{Object.keys(MODES).map((name) => <Button key={name} size="sm" testId={`fixture-${name}`} variant={selected === name ? 'secondary' : 'ghost'} onClick={() => pick(name)}>{name}</Button>)}</div>
    <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0, paddingTop: 24 }}><Machines /></div>
    <NetworkIntroSurface />
  </div>
}
render(<ThemeProvider><Fixture /></ThemeProvider>, { title: 'Machine network intro', width: 1100, height: 820, focus: false, onKeyDown: onWindowKeyDown })
process.stdin.on('end', () => { server.stop(true); process.exit(0) })
process.stdin.on('close', () => { server.stop(true); process.exit(0) })
