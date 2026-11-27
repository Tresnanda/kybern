import { describe, expect, test } from 'bun:test'
import type { AccountSummary, ProviderKind, ProviderLimits, ProviderStatus } from '../../../../packages/kybern-client/src/types.ts'
import { chipsFor, usableMachines } from './chips.ts'
import { accountAway, switchChoices } from './limit.ts'
import { accountKey, isOutdatedMachine, leftOf, limitsOn, otherAccountName, outdatedMachineLabel, outdatedMachines, railEntries, standings, suggestAccount, unifyAccounts, type MachineAccounts, type UnifiedAccount } from './unified.ts'

const NOW = Date.parse('2026-11-27T10:00:00Z')

export const summary = (kind: ProviderKind, instance: string, patch: Partial<AccountSummary> = {}): AccountSummary => ({
  provider: { kind, instance },
  name: instance === 'default' ? 'CLI account' : instance,
  status: 'signed_in',
  is_default: instance === 'default',
  projects: [],
  managed: instance !== 'default',
  can_sign_out: instance !== 'default',
  ...patch,
})
const named = (instance: string, name: string, email: string, patch: Partial<AccountSummary> = {}) => summary('claude-code', instance, { name, identity: { email }, is_default: false, ...patch })

export const installed = (...kinds: ProviderKind[]): ProviderStatus[] => kinds.map((kind) => ({ kind, display_name: kind, available: true, supported_permission_modes: [], supports_fork: false, supports_model_switch: true, models: [], instances: [] }))

export const limit = (provider: ProviderKind, used: number, patch: Partial<ProviderLimits> = {}, window = 300): ProviderLimits => ({
  provider, limits: [{ name: window === 300 ? 'five_hour' : 'weekly', used_percent: used, window_minutes: window, resets_at: NOW / 1000 + 3600 }], updated_at: '2026-11-27T09:59:00Z', ...patch,
})

export const machine = (machineId: string, name: string, accounts: AccountSummary[], patch: Partial<MachineAccounts> = {}): MachineAccounts => ({
  machineId, name, isLocal: false, online: true, state: 'ready', accounts, providers: installed('claude-code', 'codex', 'cursor', 'antigravity'), limits: [], globalLimits: [], features: [], ...patch,
})

const accountsOf = (machines: MachineAccounts[], kind: ProviderKind = 'claude-code', shared = {}) => unifyAccounts(machines, { shared }).find((g) => g.kind === kind)?.accounts ?? []
const find = (accounts: UnifiedAccount[], name: string) => accounts.find((a) => a.name === name)!

describe('unifyAccounts', () => {
  test('groups the same email on two machines into one account, whatever its case and local name', () => {
    const accounts = accountsOf([
      machine('mac', 'MacBook', [named('a1', 'Work', 'Me@Work.com')], { isLocal: true }),
      machine('fedora', 'fedora', [named('b7', 'work laptop', 'me@work.com')]),
    ])
    expect(accounts).toHaveLength(1)
    expect(accounts[0]!.key).toBe('claude-code:me@work.com')
    expect(accounts[0]!.name).toBe('Work')
    expect(accounts[0]!.presences.map((p) => [p.machineId, p.instance])).toEqual([['mac', 'a1'], ['fedora', 'b7']])
  })

  test('merges a terminal login into the account with its email and tags it on that machine', () => {
    const accounts = accountsOf([
      machine('mac', 'MacBook', [summary('claude-code', 'default', { identity: { email: 'me@work.com' } }), named('a1', 'Work', 'other@x.com')], { isLocal: true }),
      machine('fedora', 'fedora', [named('b7', 'Work', 'me@work.com')]),
    ])
    const work = accounts.find((a) => a.key === 'claude-code:me@work.com')!
    expect(work.name).toBe('Work')
    expect(standings(work).map((s) => [s.machine, s.terminal])).toEqual([['MacBook', true], ['fedora', false]])
    expect(chipsFor(work, [machine('mac', 'MacBook', [], { isLocal: true }), machine('fedora', 'fedora', [])]).map((c) => c.label)).toEqual(['MacBook · Terminal login', 'fedora'])
  })

  test('uses the daemon’s key and terminal flag when it sends them', () => {
    const accounts = accountsOf([
      machine('mac', 'MacBook', [summary('claude-code', 'default', { key: 'claude-code:me@work.com', terminal: true })], { isLocal: true }),
      machine('fedora', 'fedora', [named('b7', 'Work', 'me@work.com')]),
    ])
    expect(accounts).toHaveLength(1)
    expect(accounts[0]!.presences[0]!.terminal).toBe(true)
  })

  test('keeps signed-out terminal logins with no account out of the rows, listed once per agent', () => {
    const groups = unifyAccounts([
      machine('mac', 'MacBook', [summary('claude-code', 'default', { status: 'signed_out', is_default: false }), named('a1', 'Work', 'me@work.com')], { isLocal: true }),
      machine('fedora', 'fedora', [summary('claude-code', 'default', { status: 'needs_sign_in' })]),
    ])
    expect(groups[0]!.accounts.map((a) => a.name)).toEqual(['Work'])
    expect(groups[0]!.signedOutTerminals.map((e) => [e.machine, e.defaultThere])).toEqual([['MacBook', false], ['fedora', true]])
  })

  test('puts a signed-out terminal login on its account’s chip when the account is known', () => {
    const machines = [
      machine('mac', 'MacBook', [named('a1', 'Work', 'me@work.com')], { isLocal: true }),
      machine('fedora', 'fedora', [summary('claude-code', 'default', { status: 'signed_out', key: 'claude-code:me@work.com' })]),
      machine('vps', 'vps', [named('b', 'Work', 'me@work.com'), summary('claude-code', 'default', { status: 'signed_out', identity: { email: 'me@work.com' } })]),
    ]
    const group = unifyAccounts(machines)[0]!
    expect(group.signedOutTerminals).toEqual([])
    const chips = chipsFor(group.accounts[0]!, machines)
    expect(chips.map((c) => [c.label, c.state, c.terminal])).toEqual([['MacBook', 'signed_in', false], ['fedora · Signed out', 'signed_out', false], ['vps · Terminal signed out', 'terminal_out', false]])
  })

  test('keeps a working login with no identity as its own row, after the accounts', () => {
    const accounts = accountsOf([machine('mac', 'MacBook', [summary('claude-code', 'default', { status: 'signed_in' }), named('a1', 'Work', 'me@work.com')], { isLocal: true })])
    expect(accounts.map((a) => [a.name, a.terminalOnly])).toEqual([['Work', false], ['Terminal login', true]])
  })

  test('marks no default when this machine’s own default is a signed-out terminal login', () => {
    const accounts = accountsOf([
      machine('mac', 'MacBook', [summary('claude-code', 'default', { status: 'signed_out' }), named('a1', 'Work', 'me@work.com')], { isLocal: true }),
      machine('fedora', 'fedora', [named('b', 'Home', 'me@home.com', { is_default: true })]),
    ])
    expect(accounts.filter((a) => a.isDefault)).toEqual([])
  })

  test('hides a terminal login of an agent that machine doesn’t have', () => {
    const accounts = accountsOf([machine('mac', 'MacBook', [summary('claude-code', 'default', { status: 'signed_out' })], { isLocal: true, providers: [{ ...installed('claude-code')[0]!, available: false }] })])
    expect(accounts).toEqual([])
  })

  test('shows a borrowed account with its lender, and as unreachable while the lender is away', () => {
    const borrowed = (state: 'borrowing' | 'broker_offline') => named('b1', 'Work', 'me@work.com', { broker: { machine_id: 'fedora', machine_name: 'fedora', broker_account: 'x', state } })
    const machines = [
      machine('fedora', 'fedora', [named('x', 'Work', 'me@work.com')]),
      machine('win', 'SatyaMas', [borrowed('borrowing')]),
      machine('vps', 'vps', [borrowed('broker_offline')]),
      machine('mac', 'MacBook', [], { isLocal: true }),
    ]
    const work = find(accountsOf(machines), 'Work')
    expect(standings(work).map((s) => [s.machine, s.state, s.lender])).toEqual([['fedora', 'signed_in', undefined], ['SatyaMas', 'borrowed', 'fedora'], ['vps', 'borrow_unreachable', 'fedora']])
    expect(chipsFor(work, machines).map((c) => [c.label, c.state])).toEqual([
      ['fedora', 'signed_in'], ['SatyaMas · from fedora', 'borrowed'], ['vps · fedora unreachable', 'unreachable'], ['MacBook', 'add'],
    ])
    expect(usableMachines(work)).toEqual(['fedora', 'SatyaMas'])
  })

  test('keeps an offline machine’s last accounts and marks them offline', () => {
    const machines = [machine('mac', 'MacBook', [named('a1', 'Work', 'me@work.com')], { isLocal: true }), machine('fedora', 'fedora', [named('b', 'Work', 'me@work.com')], { online: false, state: 'unreachable' })]
    expect(chipsFor(find(accountsOf(machines), 'Work'), machines).map((c) => c.label)).toEqual(['MacBook', 'fedora · Offline'])
  })

  test('a lone machine shows chips only for what isn’t a plain sign-in', () => {
    const machines = [machine('mac', 'MacBook', [named('a1', 'Work', 'me@work.com'), summary('claude-code', 'default', { identity: { email: 'me@home.com' } }), named('a2', 'Old', 'old@x.com', { status: 'needs_sign_in' })], { isLocal: true })]
    const accounts = accountsOf(machines)
    expect(chipsFor(find(accounts, 'Work'), machines)).toEqual([])
    expect(chipsFor(find(accounts, 'me@home.com'), machines).map((c) => c.label)).toEqual(['Terminal login'])
    expect(chipsFor(find(accounts, 'Old'), machines).map((c) => c.label)).toEqual(['Signed out'])
  })

  test('keeps profiles of agents without a sign-in as machine rows and hides their own login', () => {
    const accounts = accountsOf([machine('mac', 'MacBook', [summary('omp', 'default'), summary('omp', 'p1', { name: 'Side', identity: { email: 'a@b.c' } })], { isLocal: true, providers: installed('omp') })], 'omp')
    expect(accounts.map((a) => [a.name, a.key])).toEqual([['Side', null]])
  })

  test('applies the shared name, colour and manual choice, and one default for every machine', () => {
    const machines = [
      machine('mac', 'MacBook', [named('a1', 'Work', 'me@work.com', { is_default: true }), named('a2', 'Home', 'me@home.com')], { isLocal: true }),
      machine('fedora', 'fedora', [named('b', 'Home', 'me@home.com', { is_default: true })]),
    ]
    const shared = { defaults: { 'claude-code': 'claude-code:me@home.com' }, profiles: { 'claude-code:me@home.com': { name: 'Personal', color: 'green', manual_only: true } } }
    const accounts = accountsOf(machines, 'claude-code', shared)
    const personal = find(accounts, 'Personal')
    expect(personal).toMatchObject({ color: 'green', manualOnly: true, isDefault: true })
    expect(find(accounts, 'Work').isDefault).toBe(false)
    // Without a shared choice the machine this window is on decides.
    expect(find(accountsOf(machines), 'Work').isDefault).toBe(true)
  })

  test('an account name falls back to its email', () => {
    expect(accountsOf([machine('mac', 'MacBook', [summary('claude-code', 'default', { identity: { email: 'me@work.com', plan: 'Max' } })], { isLocal: true })])[0]).toMatchObject({ name: 'me@work.com', plan: 'Max' })
    expect(accountKey('codex', '  Me@X.com ')).toBe('codex:me@x.com')
    expect(accountKey('codex', '')).toBeNull()
  })

  test('outdated machines never produce an anonymous Terminal login row and list once as "<machine> · Update Kybern"', () => {
    const machines = [
      machine('mac', 'MacBook', [named('a1', 'Work', 'me@work.com', { key: 'claude-code:me@work.com' })], { isLocal: true, features: ['network.v1', 'accounts.shared.v1'] }),
      // A legacy daemon (state: 'legacy') whose local fallback had an anonymous CLI account.
      machine('old', 'OldBox', [summary('claude-code', 'default', { status: 'signed_in' })], { state: 'legacy' }),
      // A pre-0.27 daemon that answers providers.accounts.list without accounts.shared.v1 or account keys.
      machine('fedora', 'fedora', [summary('claude-code', 'default', { status: 'signed_in' }), summary('codex', 'default', { status: 'signed_in' })], { features: ['network.v1', 'update.progress.v1'] }),
      // An offline legacy machine is not listed for update now.
      machine('away', 'AwayBox', [], { online: false, state: 'legacy' }),
    ]
    const groups = unifyAccounts(machines)
    const names = groups.flatMap((g) => g.accounts.map((a) => a.name))
    expect(names).toEqual(['Work'])
    expect(names).not.toContain('Terminal login')
    expect(isOutdatedMachine(machines[0]!)).toBe(false)
    expect(isOutdatedMachine(machines[1]!)).toBe(true)
    expect(isOutdatedMachine(machines[2]!)).toBe(true)
    expect(outdatedMachines(machines).map((m) => outdatedMachineLabel(m.name))).toEqual([
      'OldBox · Update Kybern',
      'fedora · Update Kybern',
    ])
    // Chips do not offer to add accounts onto an outdated machine either.
    expect(chipsFor(groups[0]!.accounts[0]!, machines).map((c) => c.machineId)).toEqual(['mac'])
  })
})

describe('a machine that isn’t on the shared default', () => {
  const KEY = 'claude-code:w@x.com'
  const shared = { defaults: { 'claude-code': KEY } }
  const unfollowed = (running_on: string, has_account = false, key = KEY) => [{ kind: 'claude-code' as const, key, running_on, has_account }]
  const mac = machine('mac', 'MacBook', [named('a1', 'Work', 'w@x.com', { is_default: true })], { isLocal: true })
  const fedora = (patch: Partial<MachineAccounts> = {}, accounts = [named('p', 'Personal', 'p@x.com', { is_default: true })]) =>
    machine('fedora', 'fedora', accounts, { unfollowed: unfollowed('p'), ...patch })
  const chipsOf = (machines: MachineAccounts[], name = 'Work', prefs: object = shared) => chipsFor(find(accountsOf(machines, 'claude-code', prefs), name), machines)
  const warned = (machines: MachineAccounts[], prefs: object = shared) => unifyAccounts(machines, { shared: prefs }).flatMap((g) => g.accounts).filter((a) => a.unfollowed)

  test('is one warning chip in the default’s row, naming the account it uses instead', () => {
    const machines = [mac, fedora()]
    expect(warned(machines).map((a) => [a.name, a.unfollowed])).toEqual([['Work', [{ machineId: 'fedora', uses: 'Personal', hasAccount: false }]]])
    expect(chipsOf(machines).map((c) => [c.label, c.state, c.unfollowed?.hasAccount])).toEqual([['MacBook', 'signed_in', undefined], ['fedora · Uses Personal', 'add', false]])
    // The row of the account it does use is as ever.
    expect(chipsOf(machines, 'Personal').map((c) => c.label)).toEqual(['MacBook', 'fedora'])
  })

  test('uses the shared name of that account, or says it is the terminal login', () => {
    const renamed = { ...shared, profiles: { 'claude-code:p@x.com': { name: 'Side' } } }
    expect(chipsOf([mac, fedora()], 'Work', renamed)[1]!.label).toBe('fedora · Uses Side')
    // A signed-out terminal login has no row of its own.
    const terminal = fedora({ unfollowed: unfollowed('default') }, [summary('claude-code', 'default', { status: 'signed_out' })])
    expect(chipsOf([mac, terminal])[1]!.label).toBe('fedora · Uses Terminal login')
  })

  test('keeps the login it has there when it runs another by choice', () => {
    const own = fedora({ unfollowed: unfollowed('p', true) }, [named('b', 'Work', 'w@x.com'), named('p', 'Personal', 'p@x.com', { is_default: true })])
    const chip = chipsOf([mac, own])[1]!
    expect([chip.label, chip.state, chip.unfollowed?.hasAccount, chip.standing?.presences.map((p) => p.instance)]).toEqual(['fedora · Uses Personal', 'signed_in', true, ['b']])
    // A lone machine needs no chip for a plain sign-in, but does for this.
    const alone = machine('mac', 'MacBook', [named('b', 'Work', 'w@x.com'), named('p', 'Personal', 'p@x.com', { is_default: true })], { isLocal: true, unfollowed: unfollowed('p', true) })
    expect(chipsOf([alone]).map((c) => c.label)).toEqual(['Uses Personal'])
  })

  test('says nothing when it is away, reports an older default, or does run it', () => {
    expect(warned([mac, fedora({ online: false, state: 'unreachable' })])).toEqual([])
    expect(warned([mac, fedora({ unfollowed: unfollowed('p', false, 'claude-code:old@x.com') })])).toEqual([])
    expect(warned([mac, fedora()], {})).toEqual([])
    // A borrowed sign-in whose email the machine doesn't know is still the default's.
    const borrowed = named('b', 'Work', 'w@x.com', { is_default: true, broker: { machine_id: 'mac', machine_name: 'MacBook', broker_account: 'a1', state: 'borrowing' } })
    expect(warned([mac, fedora({ unfollowed: unfollowed('b') }, [borrowed])])).toEqual([])
    expect(chipsOf([mac, fedora({ unfollowed: [] })])[1]!.label).toBe('fedora')
  })
})

describe('a delegated agent’s account', () => {
  const machines = [
    machine('mac', 'MacBook', [named('a1', 'Work', 'w@x.com', { is_default: true }), summary('claude-code', 'default', { identity: { email: 'w@x.com' }, is_default: false })], { isLocal: true }),
    machine('fedora', 'fedora', [named('b', 'Work', 'w@x.com'), named('p', 'Personal', 'p@x.com', { is_default: true }), summary('claude-code', 'default', { status: 'signed_out', is_default: false })]),
  ]
  const groups = unifyAccounts(machines)
  const on = (machineId: string, instance: string) => otherAccountName(groups, machineId, { kind: 'claude-code', instance })
  test('is named only off the default, whichever machine it runs on', () => {
    // The default account, by any of its logins on any machine, says nothing.
    expect(on('mac', 'a1')).toBeNull()
    expect(on('mac', 'default')).toBeNull()
    expect(on('fedora', 'b')).toBeNull()
    // Another account is named, even where it is that machine's own default.
    expect(on('fedora', 'p')).toBe('Personal')
  })
  test('says nothing when the account is unknown', () => {
    expect(on('fedora', 'default')).toBeNull()
    expect(on('fedora', 'gone')).toBeNull()
    expect(on('win', 'p')).toBeNull()
  })
})

describe('limits count once per account', () => {
  const machines = [
    machine('mac', 'MacBook', [named('a1', 'Work', 'me@work.com', { is_default: true })], { isLocal: true, globalLimits: [limit('claude-code', 20, { updated_at: '2026-11-27T09:00:00Z' })] }),
    machine('fedora', 'fedora', [named('b', 'Work', 'me@work.com', { is_default: true })], { limits: [limit('claude-code', 70, { instance: 'b', updated_at: '2026-11-27T09:59:00Z' })] }),
  ]
  test('reads the freshest reading of any machine', () => {
    const work = find(accountsOf(machines), 'Work')
    expect(work.limit?.machineId).toBe('fedora')
    expect(leftOf(work, NOW)).toBe(30)
  })
  test('a default account’s reading is the machine’s own entry when it has no per-account one', () => {
    expect(limitsOn(machines[0]!, machines[0]!.accounts[0]!)?.limits[0]?.used_percent).toBe(20)
  })
  test('the rail reads an account that is only on another machine through it', () => {
    const only = [
      machine('mac', 'MacBook', [summary('claude-code', 'default', { status: 'signed_out', is_default: false })], { isLocal: true }),
      machine('fedora', 'fedora', [named('b', 'Work', 'me@work.com', { is_default: true })], { limits: [limit('claude-code', 40, { instance: 'b' })] }),
    ]
    const groups = unifyAccounts(only, { shared: { defaults: { 'claude-code': 'claude-code:me@work.com' } } })
    const rail = railEntries(groups, [limit('claude-code', 5)], 'mac')
    expect(rail.map((r) => [r.kind, r.machineId, r.entry.limits[0]!.used_percent])).toEqual([['claude-code', 'fedora', 40]])
    // Nothing read there yet: no ring, never this machine's other account.
    const unread = unifyAccounts([only[0]!, { ...only[1]!, limits: [] }], { shared: { defaults: { 'claude-code': 'claude-code:me@work.com' } } })
    expect(railEntries(unread, [limit('claude-code', 5)], 'mac')).toEqual([])
  })
  test('an older daemon with no account list keeps its own rings', () => {
    expect(railEntries([], [limit('codex', 10)], 'mac').map((r) => r.kind)).toEqual(['codex'])
  })
})

describe('suggestAccount (the client’s fallback)', () => {
  const candidate = (instance: string, used: number | null, patch: { manualOnly?: boolean; usable?: boolean; weekly?: number } = {}) => ({
    instance,
    manualOnly: patch.manualOnly ?? false,
    usable: patch.usable ?? true,
    ...(used === null ? {} : { limits: { provider: 'claude-code' as const, limits: [{ name: 'five_hour', used_percent: used, window_minutes: 300, resets_at: null }, ...(patch.weekly === undefined ? [] : [{ name: 'weekly', used_percent: patch.weekly, window_minutes: 10080, resets_at: null }])] } }),
  })
  test('picks the most limit left in the window that ran out', () => {
    expect(suggestAccount([candidate('a', 100, { weekly: 10 }), candidate('b', 40, { weekly: 80 }), candidate('c', 20, { weekly: 85 })], 'a', NOW)).toBe('c')
  })
  test('skips accounts almost out of their week, manual-only ones, signed-out ones and the current one', () => {
    expect(suggestAccount([candidate('a', 100), candidate('b', 5, { weekly: 95 }), candidate('c', 10, { manualOnly: true }), candidate('d', 1, { usable: false }), candidate('e', 70)], 'a', NOW)).toBe('e')
  })
  test('prefers a known reading over none, and returns null when nothing is eligible', () => {
    expect(suggestAccount([candidate('a', 100), candidate('b', null), candidate('c', 90)], 'a', NOW)).toBe('c')
    expect(suggestAccount([candidate('a', 100), candidate('b', null)], 'a', NOW)).toBe('b')
    expect(suggestAccount([candidate('a', 100), candidate('b', 100), candidate('c', 3, { manualOnly: true })], 'a', NOW)).toBeNull()
  })
})

describe('the limit card’s choices', () => {
  const machines = [
    machine('mac', 'MacBook', [named('a1', 'Work', 'w@x.com', { is_default: true }), named('a2', 'Home', 'h@x.com'), summary('claude-code', 'default', { identity: { email: 'w@x.com' } })], {
      isLocal: true,
      limits: [limit('claude-code', 100, { instance: 'a1' }), limit('claude-code', 30, { instance: 'a2' })],
    }),
    machine('fedora', 'fedora', [named('b', 'Side', 's@x.com')]),
  ]
  const groups = unifyAccounts(machines)
  test('offers the other accounts on the thread’s machine, never another login of the same account', () => {
    const result = switchChoices(groups, 'mac', { kind: 'claude-code', instance: 'a1' }, null, NOW)
    expect(result.choices.map((c) => [c.instance, c.account.name, c.left])).toEqual([['a2', 'Home', 70]])
    expect(result.suggested?.instance).toBe('a2')
    expect(result.elsewhere.map((a) => a.name)).toEqual(['Side'])
  })
  test('takes the daemon’s suggestion over its own', () => {
    const more = unifyAccounts([{ ...machines[0]!, accounts: [...machines[0]!.accounts, named('a3', 'Spare', 'z@x.com')] }, machines[1]!])
    expect(switchChoices(more, 'mac', { kind: 'claude-code', instance: 'a1' }, 'a3', NOW).suggested?.instance).toBe('a3')
    expect(switchChoices(more, 'mac', { kind: 'claude-code', instance: 'a1' }, 'gone', NOW).suggested?.instance).toBe('a2')
  })
  test('says when the thread’s account isn’t signed in on its machine', () => {
    expect(accountAway(machines, groups, 'fedora', { kind: 'claude-code', instance: 'b' })).toBeNull()
    expect(accountAway(machines, groups, 'fedora', { kind: 'claude-code', instance: 'missing' })).toEqual({ provider: { kind: 'claude-code', instance: 'missing' }, name: null })
    const out = [{ ...machines[1]!, accounts: [named('b', 'Side', 's@x.com', { status: 'needs_sign_in' })] }]
    expect(accountAway(out, unifyAccounts(out), 'fedora', { kind: 'claude-code', instance: 'b' })?.name).toBe('Side')
    expect(accountAway([{ ...out[0]!, state: 'reading' }], [], 'fedora', { kind: 'claude-code', instance: 'b' })).toBeNull()
    expect(accountAway(out, [], 'fedora', { kind: 'opencode', instance: 'default' })).toBeNull()
    // The daemon's answer wins over the list, either way.
    expect(accountAway(machines, groups, 'fedora', { kind: 'claude-code', instance: 'b' }, true)?.name).toBe('Side')
    expect(accountAway(out, unifyAccounts(out), 'fedora', { kind: 'claude-code', instance: 'b' }, false)).toBeNull()
  })
})
