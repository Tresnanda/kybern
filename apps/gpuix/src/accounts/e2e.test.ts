// The desktop's account code fed with what a daemon really sends. The fixtures are written by the Rust serializer
// (`crates/kybern-protocol/tests/accounts_wire.rs`), so a Rust shape the TypeScript doesn't expect fails here: 0.27.0
// crashed on an offer whose `keys` the daemon left out. Each test runs the fixtures through the planners and views the
// Accounts page draws from, and asserts it neither throws nor answers nonsense.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ACCOUNTS_SHARED_FEATURE,
  type AccountLogin,
  type AccountOffer,
  type AccountSummary,
  type LoginBrokerStatus,
  type ProviderKind,
  type ProviderStatus,
  type ThreadTargetState,
} from '../../../../packages/kybern-client/src/types.ts'
import { chipsFor } from './chips.ts'
import { accountAway } from './limit.ts'
import { applyAnswers, computeOffers, listedOffers, nextCard, offerCopy, sortOffers, type Offer } from './offers.ts'
import { loginModeFor, mismatch, planAdd, planOnMachine, planSetup } from './queue.ts'
import { keyOf, presenceState, standings, unifyAccounts, type MachineAccounts } from './unified.ts'

const FIXTURES = join(import.meta.dir, '../../../../packages/kybern-client/tests/fixtures/accounts-wire')
const wire = <T>(name: string): T => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as T

const offers = () => wire<{ offers: AccountOffer[] }>('offers').offers
const accounts = () => wire<{ accounts: AccountSummary[] }>('accounts-list').accounts

const installed = (...kinds: ProviderKind[]): ProviderStatus[] =>
  kinds.map((kind) => ({ kind, display_name: kind, available: true, supported_permission_modes: [], supports_fork: false, supports_model_switch: true, models: [], instances: [] }))

const machine = (machineId: string, name: string, list: AccountSummary[], patch: Partial<MachineAccounts> = {}): MachineAccounts => ({
  machineId, name, isLocal: false, online: true, state: 'ready', accounts: list, providers: installed('claude-code', 'codex', 'cursor', 'antigravity'), limits: [], globalLimits: [], features: [ACCOUNTS_SHARED_FEATURE, 'login.broker.v1'], ...patch,
})

/** The Mac lists the fixture's accounts; the PC has only the Personal account, under its own instance id. */
const network = (): MachineAccounts[] => {
  const personal = accounts().find((a) => a.provider.instance === 'p1')!
  return [
    machine('m-mac', 'MacBook', accounts(), { isLocal: true }),
    machine('m-pc', 'PC', [{ ...personal, provider: { ...personal.provider, instance: 'x7' }, name: 'Home', directory: '/home/pc/acct' }]),
  ]
}

const view = (machines = network()) => ({ groups: unifyAccounts(machines), machines, sharing: null }) as never

describe('the daemon’s offers', () => {
  test('every kind of offer, as sent, plans, sorts and words itself without throwing', async () => {
    const { setupItems } = await import('./actions.ts')
    const sent = offers()
    expect(sent.map((offer) => offer.kind).sort()).toEqual(['always_on', 'migration_clash', 'new_machine', 'terminal_login'])
    for (const offer of sent) {
      // Straight from the wire, without the adapter's defaults: what an OfferCard and "Set up" receive.
      expect(() => setupItems(view(), offer as Offer)).not.toThrow()
      const copy = offerCopy(offer as Offer, (key) => key.split(':')[1] ?? key)
      expect(copy.title.length).toBeGreaterThan(0)
      expect(copy.title).not.toContain('undefined')
    }
    const marked = applyAnswers(sent as Offer[], { 'new_machine:m-pc': { state: 'never', fingerprint: 'x' } })
    expect(listedOffers(marked).map((offer) => offer.id)).not.toContain('new_machine:m-pc')
    // The answers decide what is hidden: the daemon's own "Not now" on the clash hides it until answered again here.
    expect(nextCard(marked)?.id).toBe('clash:claude-code:m-pc')
    expect(nextCard(sent as Offer[])?.id).toBe('new_machine:m-pc')
    expect(sortOffers(sent as Offer[])[0]!.kind).toBe('migration_clash')
    const clash = sent.find((offer) => offer.kind === 'migration_clash')!
    expect(offerCopy(clash as Offer, (key) => (key === 'claude-code:work@example.com' ? 'Work' : 'Personal')).title).toBe('m-pc’s default was Personal, now Work everywhere')
  })

  test('“Set up” on a new machine signs in exactly the accounts the offer names', async () => {
    const { setupItems } = await import('./actions.ts')
    const offer = offers().find((o) => o.kind === 'new_machine')!
    const items = setupItems(view(), offer as Offer)
    expect(items.map((item) => item.email).sort()).toEqual(['work@example.com'])
    expect(items.every((item) => item.machineId === 'm-pc' && item.method === 'sign_in')).toBe(true)
  })

  test('the adapter hands the offers on with both lists, even from a daemon that left them out', async () => {
    const { fetchDaemonOffers } = await import('./adapter.ts')
    const bare = offers().map(({ keys: _k, machines: _m, ...offer }) => offer)
    for (const sent of [offers(), bare]) {
      const client = { info: { features: [ACCOUNTS_SHARED_FEATURE] }, call: async () => ({ offers: sent }) }
      const got = await fetchDaemonOffers(client as never)
      expect(got?.every((offer) => Array.isArray(offer.keys) && Array.isArray(offer.machines))).toBe(true)
    }
  })
})

describe('the daemon’s account list', () => {
  test('every row the daemon sends becomes one account or one terminal line, keyed by its email', () => {
    const groups = unifyAccounts(network())
    const claude = groups.find((group) => group.kind === 'claude-code')!
    const byKey = new Map(claude.accounts.map((account) => [account.key, account]))
    // The terminal login with its email from `.claude.json` has a key, and is the Work account.
    expect(byKey.get('claude-code:work@example.com')?.presences.map((p) => [p.machineId, p.terminal])).toEqual([['m-mac', true]])
    // Personal on both machines is one account with two presences.
    expect(byKey.get('claude-code:me@home.org')?.presences.map((p) => p.machineId).sort()).toEqual(['m-mac', 'm-pc'])
    // Borrowed, borrowed from a lender that is away, signed out.
    expect(presenceState(accounts().find((a) => a.provider.instance === 'b1')!)).toBe('borrowed')
    expect(presenceState(accounts().find((a) => a.provider.instance === 'b2')!)).toBe('borrow_unreachable')
    expect(presenceState(accounts().find((a) => a.provider.instance === 'o1')!)).toBe('signed_out')
    for (const group of groups) {
      for (const account of group.accounts) {
        expect(() => chipsFor(account, network())).not.toThrow()
        expect(() => standings(account)).not.toThrow()
        expect(account.name.length).toBeGreaterThan(0)
      }
    }
    expect(accounts().filter((a) => a.key).every((a) => keyOf(a) === a.key)).toBe(true)
  })

  test('a terminal login whose email came from Claude’s config merges with the same account elsewhere and asks for no setup', () => {
    const terminal = accounts().find((a) => a.terminal && a.provider.kind === 'claude-code')!
    const machines = [
      machine('m-mac', 'MacBook', [terminal], { isLocal: true }),
      machine('m-pc', 'PC', [{ ...terminal, provider: { kind: 'claude-code', instance: 'w1' }, name: 'Work', terminal: false, is_default: false, directory: '/pc/work' }]),
    ]
    const groups = unifyAccounts(machines)
    const work = groups.find((g) => g.kind === 'claude-code')!.accounts.filter((a) => a.key === 'claude-code:work@example.com')
    expect(work).toHaveLength(1)
    expect(work[0]!.presences.map((p) => p.machineId).sort()).toEqual(['m-mac', 'm-pc'])
    const made = computeOffers({ groups, machines, ratios: {}, sharing: null })
    expect(made.filter((offer) => offer.kind === 'new_machine')).toEqual([])
  })

  test('Antigravity: adding never signs in this computer’s own login, signed out, unknown or signed in', () => {
    for (const status of ['signed_out', 'unknown', 'signed_in'] as const) {
      const own = { ...accounts().find((a) => a.provider.kind === 'antigravity' && a.terminal)!, status }
      const mac = machine('m-mac', 'MacBook', [own], { isLocal: true })
      const items = planAdd({ kind: 'antigravity', machines: [mac, machine('m-pc', 'PC', [])], computer: 'm-mac' })
      expect(items.map((item) => [item.machineId, item.ownLogin ?? false, item.named ?? false])).toEqual([['m-mac', false, true], ['m-pc', false, true]])
      // What the sign-in step then sends: a named account, never the computer's `default`.
      for (const item of items) expect(loginModeFor(item, item.machineId !== 'm-mac')).not.toBe('terminal')
    }
  })

  test('signing an account in on a machine that lacks it plans a new sign-in there', () => {
    const groups = unifyAccounts(network())
    const work = groups.find((g) => g.kind === 'claude-code')!.accounts.find((a) => a.key === 'claude-code:work@example.com')!
    expect(planOnMachine(work, { machineId: 'm-pc', name: 'PC' })).toMatchObject({ machineId: 'm-pc', email: 'work@example.com', method: 'sign_in' })
    expect(planSetup([work], { machineId: 'm-pc', name: 'PC' }, null)).toHaveLength(1)
  })
})

describe('sign-ins, targets and the lender', () => {
  test('a sign-in in every phase reads, and a mismatch is said in words', () => {
    const logins = wire<AccountLogin[]>('account-logins')
    const handoff = logins.find((login) => login.handoff)!
    expect(handoff.handoff).toEqual({ port: 54321, path: '/callback' })
    expect(handoff.url).toContain('localhost%3A54321')
    for (const login of logins) expect(() => mismatch({ email: 'someone@else.com' }, login)).not.toThrow()
    const done = logins.find((login) => login.id === 'l-done')!
    expect(mismatch({ email: 'me@home.org' }, done)).toBeNull()
    expect(mismatch({ email: 'work@example.com' }, done)).toContain('me@home.org')
  })

  test('a thread whose account is away offers the one to continue on', () => {
    const [plain, away, waiting] = wire<ThreadTargetState[]>('thread-target')
    const machines = network()
    const groups = unifyAccounts(machines)
    expect(accountAway(machines, groups, 'm-mac', plain!.target.provider, plain!.account_unavailable)).toBeNull()
    const gone = accountAway(machines, groups, 'm-mac', away!.target.provider, away!.account_unavailable)
    expect(gone?.provider).toEqual({ kind: 'claude-code', instance: 'b2' })
    expect(away!.suggested_account).toBe('p1')
    expect(waiting!.waiting_until).toBe('2026-11-27T15:00:00Z')
  })

  test('the lender’s status reads for every state', async () => {
    const { brokerLine, providerStatus } = await import('../../../../packages/kybern-client/src/loginBroker.ts')
    for (const status of wire<LoginBrokerStatus[]>('login-broker-status')) {
      for (const provider of status.providers) {
        const line = brokerLine(provider, status.broker?.name ?? undefined, provider.provider)
        expect(line.text).not.toContain('undefined')
      }
      expect(() => providerStatus(status, 'claude-code')).not.toThrow()
    }
  })

  // The lender lane adds `usable_for_new` and `reason` to the lender's status. Un-skip at integration.
  test.skip('“Set up” never borrows from a lender the daemon says is not usable for new setups', async () => {
    const { setupItems } = await import('./actions.ts')
    const machines = network()
    const offer = offers().find((o) => o.kind === 'new_machine')!
    const status = { ...wire<LoginBrokerStatus[]>('login-broker-status')[1]!, usable_for_new: false, reason: 'VPS is online less than 90% of the time' }
    const sharing = { machineId: 'm-mac', machine: 'MacBook', usable_for_new: status.usable_for_new, reason: status.reason }
    const items = setupItems({ groups: unifyAccounts(machines), machines, sharing } as never, offer as Offer)
    expect(items.every((item) => item.method === 'sign_in')).toBe(true)
  })
})
