import { describe, expect, test } from 'bun:test'
import type { AccountSummary } from '../../../../packages/kybern-client/src/types.ts'
import { accountSummary, agentRows, machineRows, stateLabel, stateTone } from './detail.ts'
import { unifyAccounts, type MachineAccounts, type UnifiedAccount } from './unified.ts'
import { installed, machine, summary } from './unified.test.ts'

const named = (instance: string, name: string, email: string, patch: Partial<AccountSummary> = {}) => summary('claude-code', instance, { name, identity: { email }, is_default: false, ...patch })
const accountsOf = (machines: MachineAccounts[], shared = {}) => unifyAccounts(machines, { shared }).find((g) => g.kind === 'claude-code')?.accounts ?? []
const find = (accounts: UnifiedAccount[], name: string) => accounts.find((a) => a.name === name)!
const states = (account: UnifiedAccount, machines: MachineAccounts[]) => machineRows(account, machines).map((row) => [row.machine, stateLabel(row)])

describe('one status per machine', () => {
  const borrowed = (state: 'borrowing' | 'broker_offline') => named('b1', 'Work', 'w@x.com', { broker: { machine_id: 'fedora', machine_name: 'fedora', broker_account: 'x', state } })

  test('says signed in, borrowed, can’t reach, offline, not signed in and not installed in plain words, this computer first', () => {
    const machines = [
      machine('fedora', 'fedora', [named('x', 'Work', 'w@x.com')]),
      machine('mac', 'MacBook', [], { isLocal: true }),
      machine('win', 'SatyaMas', [borrowed('borrowing')]),
      machine('vps', 'kdi-vps', [borrowed('broker_offline')]),
      machine('away', 'studio', [], { online: false, state: 'unreachable' }),
      machine('pi', 'pi', [], { providers: [{ ...installed('claude-code')[0]!, available: false }] }),
    ]
    // `useUnifiedAccounts` lists this computer first; the rows keep the order they are given.
    const ordered = [machines[1]!, machines[0]!, ...machines.slice(2)]
    expect(states(find(accountsOf(machines), 'Work'), ordered)).toEqual([
      ['MacBook', 'Not signed in'], ['fedora', 'Signed in'], ['SatyaMas', 'From fedora'], ['kdi-vps', 'Can’t reach fedora'], ['studio', 'Offline'], ['pi', 'Not installed'],
    ])
  })

  test('never names the terminal login: the shell’s own login is just signed in, or signed out', () => {
    const machines = [
      machine('mac', 'MacBook', [summary('claude-code', 'default', { identity: { email: 'w@x.com' } })], { isLocal: true }),
      machine('fedora', 'fedora', [summary('claude-code', 'default', { identity: { email: 'w@x.com' }, status: 'signed_out' })]),
    ]
    const rows = machineRows(accountsOf(machines)[0]!, machines)
    expect(rows.map(stateLabel)).toEqual(['Signed in', 'Signed out'])
    expect(rows.map((row) => stateLabel(row)).join(' ')).not.toContain('Terminal')
  })

  test('a named login and the terminal login of one email on one machine are one row', () => {
    const machines = [machine('mac', 'MacBook', [summary('claude-code', 'default', { identity: { email: 'w@x.com' }, status: 'signed_out' }), named('a1', 'Work', 'w@x.com')], { isLocal: true })]
    expect(states(find(accountsOf(machines), 'Work'), machines)).toEqual([['MacBook', 'Signed in']])
  })

  test('a machine too old to list accounts needs a newer Kybern; one still reading is checking', () => {
    const machines = [
      machine('mac', 'MacBook', [named('a1', 'Work', 'w@x.com')], { isLocal: true }),
      machine('old', 'fedora', [], { state: 'legacy' }),
      machine('new', 'laptop', [], { state: 'reading' }),
    ]
    expect(states(find(accountsOf(machines), 'Work'), machines)).toEqual([['MacBook', 'Signed in'], ['fedora', 'Needs a newer Kybern'], ['laptop', 'Checking…']])
  })

  test('a machine that runs another account than the shared default says which', () => {
    const shared = { defaults: { 'claude-code': 'claude-code:w@x.com' } }
    const machines = [
      machine('mac', 'MacBook', [named('a1', 'Work', 'w@x.com', { is_default: true })], { isLocal: true }),
      machine('fedora', 'fedora', [named('b', 'Work', 'w@x.com'), named('p', 'Personal', 'p@x.com', { is_default: true })], { unfollowed: [{ kind: 'claude-code', key: 'claude-code:w@x.com', running_on: 'p', has_account: true }] }),
    ]
    expect(states(find(accountsOf(machines, shared), 'Work'), machines)).toEqual([['MacBook', 'Signed in'], ['fedora', 'Uses Personal']])
  })

  test('an account without an identity lists only the machines that have it', () => {
    const machines = [machine('mac', 'MacBook', [summary('claude-code', 'default')], { isLocal: true }), machine('fedora', 'fedora', [])]
    expect(states(accountsOf(machines)[0]!, machines)).toEqual([['MacBook', 'Signed in']])
  })

  test('tones: green for usable, amber for what needs a sign-in, quiet for what can’t be acted on', () => {
    expect(['signed_in', 'borrowed', 'signed_out', 'unreachable', 'uses', 'offline', 'not_signed_in'].map((s) => stateTone(s as never))).toEqual(['ok', 'ok', 'warn', 'warn', 'neutral', 'quiet', 'quiet'])
  })
})

describe('the list row’s line', () => {
  const mac = (accounts: AccountSummary[]) => machine('mac', 'MacBook', accounts, { isLocal: true })
  const line = (machines: MachineAccounts[], name = 'Work') => { const account = find(accountsOf(machines), name); return accountSummary(account, machineRows(account, machines), machines.length) }

  test('all machines, two names, or a count', () => {
    expect(line([mac([named('a', 'Work', 'w@x.com')]), machine('f', 'fedora', [named('b', 'Work', 'w@x.com')])])).toEqual({ text: 'All machines', warn: false })
    expect(line([mac([named('a', 'Work', 'w@x.com')]), machine('f', 'fedora', [named('b', 'Work', 'w@x.com')]), machine('s', 'SatyaMas', [])])).toEqual({ text: 'MacBook · fedora', warn: false })
    const three = [mac([named('a', 'Work', 'w@x.com')]), machine('f', 'fedora', [named('b', 'Work', 'w@x.com')]), machine('v', 'kdi-vps', [named('c', 'Work', 'w@x.com')]), machine('s', 'SatyaMas', [], { online: false, state: 'unreachable' })]
    expect(line(three)).toEqual({ text: '3 machines', warn: false })
  })

  test('says where it is signed out, before anything else', () => {
    expect(line([mac([named('a', 'Work', 'w@x.com')]), machine('f', 'fedora', [named('b', 'Work', 'w@x.com', { status: 'signed_out' })])])).toEqual({ text: 'Signed out on fedora', warn: true })
  })

  test('on a lone machine: the email and plan, or that it is signed out', () => {
    expect(line([mac([named('a', 'Work', 'w@x.com', { identity: { email: 'w@x.com', plan: 'Max' } })])])).toEqual({ text: 'w@x.com · Max', warn: false })
    expect(line([mac([named('a', 'Work', 'w@x.com', { status: 'signed_out' })])])).toEqual({ text: 'Signed out', warn: true })
  })
})

describe('an agent with no account', () => {
  test('lists the machines whose own login is signed out, offline ones and the update a machine needs', () => {
    const machines = [
      machine('mac', 'MacBook', [summary('codex', 'default', { status: 'signed_out' })], { isLocal: true }),
      machine('f', 'fedora', [summary('codex', 'default', { status: 'signed_out' })], { online: false, state: 'unreachable' }),
      machine('o', 'old', [], { state: 'legacy' }),
      machine('n', 'nocodex', [], { providers: installed('claude-code').concat([{ ...installed('codex')[0]!, available: false }]) }),
    ]
    const group = unifyAccounts(machines).find((g) => g.kind === 'codex')!
    expect(group.accounts).toEqual([])
    expect(agentRows(group, machines).map((row) => [row.machine, stateLabel(row)])).toEqual([['MacBook', 'Not signed in'], ['fedora', 'Offline'], ['old', 'Needs a newer Kybern'], ['nocodex', 'Not installed']])
  })
})
