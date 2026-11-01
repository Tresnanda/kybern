// Dev-only fixture for Settings › Computer use and the live view's paused state (ADE-83). An in-process socket answers
// `computer.status` the way each OS and driver would, so Windows, Linux and agent-desktop can be seen on a Mac. Nothing
// reaches a real daemon. Drive it with `computer.shots.ts`.
import '../native/local-build.ts'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { render } from '@gpuix/react'
import { useState } from 'react'
import { PROTOCOL_VERSION, type ComputerNote, type ComputerStatus, type Settings, type Thread } from '../../../../packages/kybern-client/src/types.ts'
import { emptyThreadState } from '../../../../packages/kybern-client/src/transcript.ts'
import { connect, set, useApp } from '../state.ts'
import { ThemeProvider, useTheme, Label } from '../ui.tsx'
import { Button } from '../kit/Button.tsx'
import { ComputerUse } from './Computer.tsx'
import { ComputerLiveView } from '../live/ComputerLiveView.tsx'
import { onWindowKeyDown } from '../nav/keys.ts'

const at = '2026-11-01T02:00:00Z'
const check = (name: string, ok: boolean, message: string, fix?: string) => ({ name, ok, message, fix: fix ?? null })
const base = { supported: true, enabled: true, installed: true, app_path: null, required_version: '0.1.4', signed: true, accessibility: 'granted', screen_recording: 'granted', ready: true } as const
const MAC_DRIVERS = ['cua_driver', 'agent_desktop'] as const
const STATUS: Record<string, ComputerStatus> = {
  'mac-cua': { ...base, app_path: '/Applications/CuaDriver.app', version: '0.1.6', platform: 'macos', driver: 'cua_driver', drivers: [...MAC_DRIVERS], checks: [check('installed', true, 'CuaDriver is installed')] },
  'mac-cua-missing': { ...base, installed: false, ready: false, version: null, signed: false, accessibility: 'unknown', screen_recording: 'unknown', platform: 'macos', driver: 'cua_driver', drivers: [...MAC_DRIVERS], checks: [check('installed', false, 'CuaDriver is not installed.', 'Install CuaDriver.')] },
  'mac-agent': { ...base, version: '0.4.2', required_version: '0.4.0', platform: 'macos', driver: 'agent_desktop', drivers: [...MAC_DRIVERS], permission_holder: 'Kybern', accessibility: 'missing', screen_recording: 'missing', ready: false, checks: [check('installed', true, 'agent-desktop is installed'), check('accessibility', false, 'Accessibility is off for Kybern.'), check('screen_recording', false, 'Screen Recording is off for Kybern.')] },
  'mac-agent-granted': { ...base, version: '0.4.2', required_version: '0.4.0', platform: 'macos', driver: 'agent_desktop', drivers: [...MAC_DRIVERS], permission_holder: 'Kybern', checks: [check('installed', true, 'agent-desktop is installed')] },
  'windows': { ...base, version: '0.4.2', required_version: '0.4.0', signed: true, platform: 'windows', driver: 'agent_desktop', drivers: ['agent_desktop'], checks: [check('installed', true, 'agent-desktop is installed'), check('uia', true, 'Windows UI Automation answers.'), check('screenshots', true, 'Screenshots work on the active desktop.'), check('integrity', true, 'Kybern runs at the same integrity level as the apps it controls.')] },
  'linux-wayland': { ...base, version: '0.4.2', required_version: '0.4.0', signed: false, ready: false, platform: 'linux', driver: 'agent_desktop', drivers: ['agent_desktop'], session: 'wayland (GNOME)', checks: [check('installed', true, 'agent-desktop is installed'), check('at-spi', false, 'The accessibility bus (AT-SPI) is not reachable, so apps cannot be read.', 'Turn on “Assistive technologies” in Settings › Accessibility, then sign out and back in.'), check('portal', true, 'The screenshot portal is available.')] },
  'linux-long': { ...base, version: '0.4.2', required_version: '0.4.0', signed: false, ready: false, platform: 'linux', driver: 'agent_desktop', drivers: ['agent_desktop'], session: 'wayland (KDE Plasma) over a very long remote desktop session name that keeps going', checks: [check('installed', true, 'agent-desktop is installed'), check('at-spi', false, 'The accessibility bus (AT-SPI) did not answer within five seconds on /run/user/1000/at-spi/bus_0, so Kybern cannot read any application windows until it does.', 'Run `gsettings set org.gnome.desktop.interface toolkit-accessibility true`, then sign out and back in, and check that the org.a11y.Bus service is running under your user session.')] },
  'old-daemon': { ...base, app_path: '/Applications/CuaDriver.app', version: '0.1.6', checks: [] },
}
const NOTES: ComputerNote[] = [
  { bundle_id: 'code.exe', app_id: 'code.exe', app: 'Visual Studio Code', text: 'Open the command palette with Ctrl+Shift+P.', updated_at: at },
  { bundle_id: 'org.gnome.Nautilus.desktop', app_id: 'org.gnome.Nautilus.desktop', app: 'Files with an exceptionally long application display name that must wrap or truncate', text: 'Pick rows by name.', updated_at: at },
  { bundle_id: 'com.apple.Notes', app: 'Notes', text: 'Click the note body before typing.', updated_at: at },
]
let mode = process.env.FIXTURE_MODE ?? 'mac-cua', frameMode: 'ok' | 'paused' | 'paused-only' = 'ok', driver: string | null = null
const fixtureFrame = process.env.FIXTURE_FRAME ? readFileSync(process.env.FIXTURE_FRAME).toString('base64') : ''
const thread = (): Thread => ({ id: 'fixture-live', title: 'Add milk to the shopping list', project_id: 'fixture', provider: { kind: 'claude-code', instance: 'default' }, status: 'running', permission_mode: 'supervised', created_at: at, updated_at: at } as unknown as Thread)
const settings = () => ({ computer_use: { enabled: true, foreground: 'ask', always_allowed_apps: ['Notes', 'Calendar'], driver }, ask_deadlines: { enabled: true, max_seconds: 900 } }) as unknown as Settings

const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(req, s) { if (s.upgrade(req)) return; return new Response('fixture') }, websocket: { message(ws, raw) {
  const request = JSON.parse(String(raw)); let result: unknown = {}; const params = request.params ?? {}
  switch (request.method) {
    case 'daemon.info': result = { protocol_version: PROTOCOL_VERSION, environment_id: 'computer-fixture', version: 'fixture' }; break
    case 'projects.list': result = { projects: [] }; break
    case 'threads.list': result = { threads: [thread()] }; break
    case 'threads.messages.list': result = { messages: [] }; break
    case 'tasks.list': result = { tasks: [] }; break
    case 'events.subscribe': result = { subscription_id: 'fixture', head_seq: 0, replay_ready: true }; break
    case 'settings.get': result = settings(); break
    case 'settings.update': driver = params.settings?.computer_use?.driver ?? null; result = { ...settings(), ...params.settings }; break
    case 'computer.status': case 'computer.setup': result = STATUS[mode] ?? STATUS['mac-cua']; break
    case 'computer.notes.list': result = { notes: NOTES }; break
    case 'computer.frame': result = frameMode === 'ok'
      ? { frame: { seq: 1, window_id: 1, app: 'Notes', title: 'Shopping', action: 'Typed “Milk”', media_type: 'image/png', data: fixtureFrame, width: 640, height: 400, point: [0.4, 0.5], captured_at: new Date().toISOString() } }
      : frameMode === 'paused' ? { frame: null, paused: 'Screenshot permission was declined. Kybern asks again on the next task.' } : { frame: null, paused: 'Waiting for screenshot permission from the desktop portal.' }; break
  }
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }))
  set({ statusDetail: `${request.method}:${Date.now()}` })
} } })
process.env.KYBERN_URL = `ws://127.0.0.1:${server.port}/ws`
process.env.KYBERN_TOKEN = 'fixture'
if (!process.env.KYBERN_DATA_DIR) throw Error('Fixture requires an isolated data directory')
mkdirSync(process.env.KYBERN_DATA_DIR, { recursive: true })
writeFileSync(path.join(process.env.KYBERN_DATA_DIR, 'daemon.port'), String(server.port))
writeFileSync(path.join(process.env.KYBERN_DATA_DIR, 'daemon.token'), 'fixture', { mode: 0o600 })
connect()
set({ selectedId: 'fixture-live', threads: [thread()], open: { ...emptyThreadState(), thread: thread(), loaded: true } })

const MODES = [...Object.keys(STATUS), 'live-ok', 'live-paused', 'live-paused-only']
function Fixture() {
  useApp((s) => s.statusDetail)
  const t = useTheme(), [selected, choose] = useState(mode)
  const live = selected.startsWith('live')
  return <div testId="fixture-ready" style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', position: 'relative', backgroundColor: t.surface }}>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: 10 }}>{MODES.map((name) => <Button key={name} size="sm" testId={`fixture-${name}`} variant={selected === name ? 'secondary' : 'ghost'} onClick={() => { choose(name); if (name.startsWith('live')) frameMode = name === 'live-ok' ? 'ok' : name === 'live-paused' ? 'paused' : 'paused-only'; else mode = name }}>{name}</Button>)}</div>
    {!live && <div style={{ flexGrow: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', alignItems: 'center' }}><div style={{ display: 'flex', flexDirection: 'column', width: Number(process.env.FIXTURE_WIDTH ?? 760), marginTop: -Number(process.env.FIXTURE_SHIFT ?? 0), flexShrink: 0 }}><ComputerUse key={selected} /></div></div>}
    {live && <div style={{ flexGrow: 1 }}><ComputerLiveView /></div>}
  </div>
}
render(<ThemeProvider><Fixture /></ThemeProvider>, { title: 'Computer use', width: 900, height: Number(process.env.FIXTURE_HEIGHT ?? 1500), focus: false, onKeyDown: onWindowKeyDown })
process.stdin.on('end', () => { server.stop(true); process.exit(0) })
process.stdin.on('close', () => { server.stop(true); process.exit(0) })
