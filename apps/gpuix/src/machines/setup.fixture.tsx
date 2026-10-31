// Native-only setup panel fixture: no daemon, network, SSH, credential or service access.
import '../native/local-build.ts'
import { render } from '@gpuix/react'
import { useState } from 'react'
import { ThemeProvider, useTheme } from '../ui.tsx'
import { onWindowKeyDown } from '../nav/keys.ts'
import { MachineSetupPanel } from './MachineSetup.tsx'
import type { SetupRow, SetupState } from './setup.ts'

const initial: SetupState = { discovering: false, error: '', rows: [
  { target: { id: 'installed', name: 'Studio Mac', os: 'darwin', access: 'paired' }, phase: 'ready', detail: 'Joins machines on the same Tailscale account automatically.' },
  { target: { id: 'missing', name: 'Build server', os: 'linux', access: 'ssh', target: 'build' }, phase: 'install', detail: 'Install the Kybern daemon and CLI to connect.' },
  { target: { id: 'off', name: 'Workstation kept separate', os: 'windows', access: 'paired' }, phase: 'off', detail: 'Turn on networking on that machine to connect.' },
  { target: { id: 'failed', name: 'A machine with a long name that should wrap without hiding its retry action', access: 'ssh', target: 'offline' }, phase: 'error', detail: 'SSH could not sign in without a password. Load your SSH key and retry.' },
  { target: { id: 'untrusted', name: 'New tailnet computer', access: 'guidance', online: false }, phase: 'access', detail: 'Add a pairing invitation or save and verify an SSH connection to set up this machine.' },
] }
function Fixture() {
  const t = useTheme(), [state, setState] = useState(initial)
  const update = (row: SetupRow, phase: SetupRow['phase'], detail: string) => setState(state => ({ ...state, rows: state.rows.map(item => item.target.id === row.target.id ? { ...item, phase, detail } : item) }))
  return <div testId="setup-fixture-ready" style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', overflowY: 'scroll', backgroundColor: t.surface, padding: 16 }}>
    <MachineSetupPanel state={state} onCheck={() => setState(initial)}
      onInstall={row => update(row, 'installing', 'Installing the daemon and CLI')}
      onCancel={row => update(row, 'canceled', 'Setup canceled. Retry when you are ready.')}
      onRetry={row => update(row, 'ready', 'Joins machines on the same Tailscale account automatically.')}
      onAccess={row => update(row, 'access', 'Fixture: access setup selected. No connection opened.')} />
  </div>
}
render(<ThemeProvider><Fixture /></ThemeProvider>, { title: 'Machine setup fixture', width: Number(process.env.SETUP_WIDTH ?? 760), height: 900, focus: false, onKeyDown: onWindowKeyDown })
process.stdin.on('end', () => process.exit(0))
process.stdin.on('close', () => process.exit(0))
