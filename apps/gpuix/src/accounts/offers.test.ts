import { describe, expect, test } from 'bun:test'
import { ACCOUNTS_SHARED_FEATURE, LOGIN_HANDOFF_FEATURE, type AccountSummary } from '../../../../packages/kybern-client/src/types.ts'
import { canHandoff } from './adapter.ts'
import { applyAnswers, computeOffers, listedOffers, nextCard, offerCopy, type Offer, type OfferContext } from './offers.ts'
import { advance, fallbackModeFor, loginModeFor, mismatch, planAdd, planOnMachine, planSetup, resolvedItem, startQueue } from './queue.ts'
import { unifyAccounts, type MachineAccounts } from './unified.ts'
import { machine, summary } from './unified.test.ts'

const claude = (instance: string, name: string, email: string, patch: Partial<AccountSummary> = {}) => summary('claude-code', instance, { name, identity: { email }, is_default: false, ...patch })
const codex = (instance: string, email: string) => summary('codex', instance, { name: email, identity: { email } })

const mac = (patch: Partial<MachineAccounts> = {}) => machine('mac', 'MacBook', [claude('a1', 'Work', 'w@x.com'), codex('c1', 'c@x.com')], { isLocal: true, features: ['login.broker.v1'], ...patch })
const fedora = (accounts: AccountSummary[] = [], patch: Partial<MachineAccounts> = {}) => machine('fedora', 'fedora', accounts, { features: ['login.broker.v1'], ...patch })

const context = (machines: MachineAccounts[], patch: Partial<OfferContext> = {}): OfferContext => ({ machines, groups: unifyAccounts(machines), ratios: {}, sharing: null, ...patch })
const ids = (offers: Offer[]) => offers.map((o) => o.id)

describe('computeOffers', () => {
  test('offers a new machine only the accounts it is missing', () => {
    const offers = computeOffers(context([mac(), fedora([claude('b', 'Work', 'w@x.com')])]))
    expect(offers).toEqual([{ id: 'new_machine:fedora', kind: 'new_machine', fingerprint: 'codex:c@x.com', machine_id: 'fedora', machine_name: 'fedora', keys: ['codex:c@x.com'], machines: ['mac'] }])
  })
  test('offers nothing for agents a machine doesn’t have, offline machines, or one machine alone', () => {
    expect(computeOffers(context([mac(), fedora([], { providers: [] })]))).toEqual([])
    expect(computeOffers(context([mac(), fedora([], { online: false, state: 'unreachable' })]))).toEqual([])
    expect(computeOffers(context([mac()]))).toEqual([])
  })
  test('offers sharing an always-on machine’s sign-ins only when it would save sign-ins', () => {
    const machines = [mac(), fedora([claude('b', 'Work', 'w@x.com')], {})]
    const on = computeOffers(context(machines, { ratios: { mac: 0.97, fedora: 0.2 } }))
    // Codex on the Mac isn't lacking on fedora's side only: fedora has no Codex account.
    expect(ids(on)).toContain('always_on:mac')
    expect(on.find((o) => o.kind === 'always_on')).toMatchObject({ keys: ['codex:c@x.com'], machines: ['fedora'] })
    expect(ids(computeOffers(context(machines, { ratios: { mac: 0.5 } })))).not.toContain('always_on:mac')
    expect(ids(computeOffers(context(machines, { ratios: { mac: 0.97 }, sharing: 'fedora' })))).not.toContain('always_on:mac')
    const complete = [mac(), fedora([claude('b', 'Work', 'w@x.com'), codex('d', 'c@x.com')])]
    expect(computeOffers(context(complete, { ratios: { mac: 0.99 } }))).toEqual([])
  })
  test('offers signing an empty terminal login in only where the daemon can', () => {
    const empty = [summary('claude-code', 'default', { status: 'signed_out' }), claude('b', 'Work', 'w@x.com')]
    const able = computeOffers(context([mac(), fedora([...empty, codex('d', 'c@x.com')], { features: [ACCOUNTS_SHARED_FEATURE] })]))
    expect(ids(able)).toEqual(['terminal_login:fedora:claude-code'])
    expect(computeOffers(context([mac(), fedora([...empty, codex('d', 'c@x.com')], { features: [] })]))).toEqual([])
    // An agent nobody signs in to anywhere is not worth asking about.
    const unused = fedora([summary('cursor', 'default', { status: 'signed_out' }), claude('b', 'Work', 'w@x.com'), codex('d', 'c@x.com')], { features: [ACCOUNTS_SHARED_FEATURE] })
    expect(computeOffers(context([mac(), unused]))).toEqual([])
  })
})

const offer = (id: string, patch: Partial<Offer> = {}): Offer => ({ id, kind: 'new_machine', fingerprint: 'a', machine_id: 'fedora', machine_name: 'fedora', keys: [], machines: [], ...patch })

describe('answers', () => {
  test('“Not now” holds until the situation changes; “Never” holds', () => {
    const answers = { one: { state: 'later' as const, fingerprint: 'a' }, two: { state: 'never' as const, fingerprint: 'old' }, three: { state: 'later' as const, fingerprint: 'old' } }
    const marked = applyAnswers([offer('one'), offer('two'), offer('three')], answers)
    expect(marked.map((o) => o.dismissed ?? null)).toEqual(['later', 'never', null])
    expect(nextCard(marked)?.id).toBe('three')
    // The page still lists what "Not now" hid, never what "Never" did.
    expect(listedOffers(marked).map((o) => o.id)).toEqual(['one', 'three'])
  })
  test('a daemon’s dismissed flag stops counting when the fingerprint moved on', () => {
    expect(applyAnswers([offer('one', { dismissed: 'later', fingerprint: 'b' })], { one: { state: 'later', fingerprint: 'a' } })[0]!.dismissed).toBeUndefined()
  })
  test('one card at a time: a changed default first, then setting up, sharing, the terminal', () => {
    const offers = [offer('t', { kind: 'terminal_login' }), offer('s', { kind: 'always_on' }), offer('c', { kind: 'migration_clash' }), offer('n')]
    expect(nextCard(offers)?.id).toBe('c')
    expect(nextCard(offers, new Set(['c:a']))?.id).toBe('n')
  })
  test('says what each card does', () => {
    const name = (key: string) => ({ 'claude-code:p@x.com': 'Personal', 'claude-code:w@x.com': 'Work' })[key] ?? key
    expect(offerCopy(offer('n'), name)).toEqual({ title: 'Use your accounts on fedora?', action: 'Set up' })
    expect(offerCopy(offer('c', { kind: 'migration_clash', clash: { kind: 'claude-code', machine_id: 'fedora', was: 'claude-code:p@x.com', now: 'claude-code:w@x.com' } }), name))
      .toEqual({ title: 'fedora’s default was Personal, now Work everywhere', action: 'Keep', alternative: 'Change' })
    expect(offerCopy(offer('t', { kind: 'terminal_login', provider: 'codex' }), name).title).toBe('Sign in Codex in fedora’s terminal?')
  })
})

describe('sign-in queue', () => {
  const machines = [mac(), fedora([claude('b', 'Work', 'w@x.com', { status: 'needs_sign_in' })])]
  const work = unifyAccounts(machines).find((g) => g.kind === 'claude-code')!.accounts[0]!

  test('adds one new account with one sign-in per ticked machine, sharing the first one’s email and name', () => {
    const items = planAdd({ kind: 'claude-code', name: ' ', machines, computer: 'mac' })
    expect(items.map((i) => [i.machineId, i.method, i.name])).toEqual([['mac', 'sign_in', undefined], ['fedora', 'sign_in', undefined]])
    let queue = startQueue(items)
    queue = advance(queue, 'signed_in', { email: 'new@x.com', name: 'new@x.com', color: 'green' })
    expect(resolvedItem(queue)).toMatchObject({ machineId: 'fedora', email: 'new@x.com', name: 'new@x.com', color: 'green' })
    queue = advance(queue, 'skipped')
    expect(resolvedItem(queue)).toBeNull()
    expect(queue.results).toEqual({ [items[0]!.id]: 'signed_in', [items[1]!.id]: 'skipped' })
  })
  test('Antigravity signs this computer’s own agy in first, and named accounts everywhere else', () => {
    expect(planAdd({ kind: 'antigravity', machines, computer: 'mac' }).map((i) => [i.ownLogin ?? false, i.named ?? false])).toEqual([[true, false], [false, true]])
  })
  test('signs a signed-out login on a machine in again, and a missing one anew', () => {
    expect(planOnMachine(work, { machineId: 'fedora', name: 'fedora' })).toMatchObject({ instance: 'b', email: 'w@x.com', name: 'Work' })
    const missing = planOnMachine(work, { machineId: 'win', name: 'SatyaMas' })
    expect(missing.instance).toBeUndefined()
    expect(missing.email).toBe('w@x.com')
  })
  test('sets a machine up by borrowing where possible and signing in the rest after', () => {
    const accounts = unifyAccounts([mac(), fedora()]).flatMap((g) => g.accounts)
    const items = planSetup(accounts, { machineId: 'fedora', name: 'fedora' }, { machineId: 'mac', machine: 'MacBook', lendable: [{ provider: 'claude-code', account: 'a1', name: 'Work', email: 'W@x.com' }] })
    expect(items.map((i) => [i.kind, i.method, i.lender?.account])).toEqual([['claude-code', 'borrow', 'a1'], ['codex', 'sign_in', undefined]])
    // The sharing machine itself signs in directly.
    expect(planSetup(accounts, { machineId: 'mac', name: 'MacBook' }, { machineId: 'mac', machine: 'MacBook', lendable: [] }).every((i) => i.method === 'sign_in')).toBe(true)
  })
  test('Authorize only needs both daemons; otherwise a code', () => {
    const item = { kind: 'claude-code' as const }
    expect(loginModeFor(item, false)).toBe('browser')
    expect(loginModeFor(item, true)).toBe('paste')
    expect(loginModeFor(item, true, true)).toBe('browser')
    expect(loginModeFor({ kind: 'codex' }, true)).toBe('device_code')
    expect(loginModeFor({ kind: 'antigravity', instance: 'default' }, true)).toBe('terminal')
    expect(loginModeFor({ kind: 'antigravity', named: true }, true)).toBe('paste')
    expect(fallbackModeFor('codex')).toBe('device_code')
    expect(fallbackModeFor('claude-code')).toBe('paste')
    expect(canHandoff('codex', [LOGIN_HANDOFF_FEATURE], [LOGIN_HANDOFF_FEATURE])).toBe(true)
    expect(canHandoff('codex', [LOGIN_HANDOFF_FEATURE], [])).toBe(false)
    expect(canHandoff('codex', null, [LOGIN_HANDOFF_FEATURE])).toBe(false)
    expect(canHandoff('cursor', [LOGIN_HANDOFF_FEATURE], [LOGIN_HANDOFF_FEATURE])).toBe(false)
  })
  test('notices a sign-in that ended on another account', () => {
    expect(mismatch({ email: 'w@x.com' }, { identity: { email: 'W@x.com' } })).toBeNull()
    expect(mismatch({ email: 'w@x.com' }, { identity: { email: 'me@x.com' } })).toBe('me@x.com')
    expect(mismatch({}, { identity: { email: 'me@x.com' } })).toBeNull()
  })
})
