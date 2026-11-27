// The chip of a machine that isn't on the shared default: with no login for it there, pressing it signs that machine in.
import { afterEach, expect, test } from 'bun:test'
import { showDialog, useDialog } from '../dialogs/store.ts'
import { harness } from '../dialogs/gpuixHarness.tsx'
import type { AccountSummary } from '../../../../packages/kybern-client/src/types.ts'
import { chipsFor } from './chips.ts'
import { unifyAccounts, type MachineAccounts } from './unified.ts'

const { MachineChip } = await import('./MachineChip.tsx')
const { ThemeProvider } = await import('../ui.tsx')

let mounted: ReturnType<typeof harness> | null = null
afterEach(() => { mounted?.close(); mounted = null; showDialog(null) })

const account = (instance: string, name: string, email: string): AccountSummary => ({ provider: { kind: 'claude-code', instance }, name, identity: { email }, status: 'signed_in', is_default: true, projects: [], managed: true, can_sign_out: true })
const machine = (machineId: string, name: string, accounts: AccountSummary[], patch: Partial<MachineAccounts> = {}): MachineAccounts => ({ machineId, name, isLocal: false, online: true, state: 'ready', accounts, providers: null, limits: [], globalLimits: [], features: [], ...patch })

test('offers to sign that machine in, saying what it uses meanwhile', () => {
  const KEY = 'claude-code:w@x.com'
  const machines = [
    machine('mac', 'MacBook', [account('a1', 'Work', 'w@x.com')], { isLocal: true }),
    machine('fedora', 'fedora', [account('p', 'Personal', 'p@x.com')], { unfollowed: [{ kind: 'claude-code', key: KEY, running_on: 'p', has_account: false }] }),
  ]
  const groups = unifyAccounts(machines, { shared: { defaults: { 'claude-code': KEY } } })
  const shared = groups[0]!.accounts.find((a) => a.key === KEY)!
  const chip = chipsFor(shared, machines).find((c) => c.machineId === 'fedora')!
  const view = { machines, groups, shared: {}, supportsShared: true, primaryId: 'mac', legacy: false, loaded: true, sharing: null }
  const opened: ReturnType<typeof useDialog>[] = []
  const Watch = () => { opened.push(useDialog()); return null }
  const h = harness()
  mounted = h
  h.render(<ThemeProvider><Watch /><MachineChip chip={chip} account={shared} view={view} actions={{ signOut: () => {}, signOutTerminal: () => {} }} /></ThemeProvider>)
  const id = h.find(`chip-${shared.id}-fedora`)!
  expect(h.text()).toContain('fedora · Not signed in')
  expect(h.props(id)['aria-label']).toBe('Sign in on fedora')
  h.fire(id, { eventType: 'click' })
  expect(opened.at(-1)).toMatchObject({ kind: 'account', items: [{ machineId: 'fedora', kind: 'claude-code', email: 'w@x.com' }] })
})
