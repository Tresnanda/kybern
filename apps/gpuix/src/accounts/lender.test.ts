import { describe, expect, test } from 'bun:test'
import type { AccountBroker, AccountSummary, LendableAccount, LoginBrokerStatus, MachineCard } from '../../../../packages/kybern-client/src/types.ts'
import { describeProblem } from '../../../../packages/kybern-client/src/problems.ts'
import { borrow, defaultMessage, defaultTakers, discardBorrow, setupItems, stopBorrowing } from './actions.ts'
import { lenderVerdict, setSharing, sharingFrom } from './adapter.ts'
import { chipsFor, sharingAction } from './chips.ts'
import type { Offer } from './offers.ts'
import { planSetup, signInHereAction, type SignInItem } from './queue.ts'
import type { UnifiedView } from './store.ts'
import { unifyAccounts, type MachineAccounts } from './unified.ts'
import { machine, summary } from './unified.test.ts'

const account = (kind: AccountSummary['provider']['kind'], instance: string, email: string, patch: Partial<AccountSummary> = {}) => summary(kind, instance, { name: email, identity: { email }, is_default: false, ...patch })
const SHARES = ['login.broker.v1']
const vps = (patch: Partial<MachineAccounts> = {}) => machine('vps', 'kdi-vps', [account('claude-code', 'a1', 'w@x.com'), account('codex', 'c1', 'c@x.com'), account('cursor', 'u1', 'u@x.com')], { features: SHARES, ...patch })
const fresh = (patch: Partial<MachineAccounts> = {}) => machine('new', 'laptop', [], { isLocal: true, features: SHARES, ...patch })

const lendable: LendableAccount[] = [
  { provider: 'claude-code', account: 'a1', name: 'Work', email: 'w@x.com' },
  { provider: 'codex', account: 'c1', name: 'Codex', email: 'c@x.com' },
  { provider: 'cursor', account: 'u1', name: 'Cursor', email: 'u@x.com' },
]
/** `login.broker.status`; `verdict` is the `lender` a 0.27.2 daemon adds, absent on older ones. */
const status = (verdict?: Record<string, unknown>) => ({ broker: { machine_id: 'vps', name: 'kdi-vps', reachable: true }, ...(verdict ? { lender: { machine_id: 'vps', name: 'kdi-vps', ...verdict } } : {}), is_broker: false, providers: [], loans: [] }) as LoginBrokerStatus
const members = (ratio?: number | null) => [{ machine_id: 'vps', name: 'kdi-vps', online_ratio_7d: ratio }] as MachineCard[]

const methods = (verdict: Record<string, unknown> | undefined, ratio?: number | null) => {
  const sharing = sharingFrom(status(verdict), members(ratio))!
  const accounts = unifyAccounts([fresh(), vps()]).flatMap((group) => group.accounts)
  return planSetup(accounts, { machineId: 'new', name: 'laptop' }, { ...sharing, lendable }).map((item) => `${item.kind}:${item.method}`)
}
const BORROWED = ['claude-code:borrow', 'codex:borrow', 'cursor:sign_in']
const OWN = ['claude-code:sign_in', 'codex:sign_in', 'cursor:sign_in']

describe('borrowing during set-up', () => {
  test('borrows from a machine the daemon calls usable, however little it is online', () => {
    expect(methods({ usable_for_new: true }, 0.1)).toEqual(BORROWED)
    expect(methods({ usable_for_new: true })).toEqual(BORROWED)
  })
  test('signs in itself when the daemon calls the sharing machine unusable, and keeps the reason', () => {
    expect(methods({ usable_for_new: false, reason: 'It sleeps.' }, 0.99)).toEqual(OWN)
    expect(sharingFrom(status({ usable_for_new: false, reason: 'It sleeps.' }), members(0.99))).toEqual({ machineId: 'vps', machine: 'kdi-vps', usable: false, reason: 'It sleeps.' })
  })
  test('on an older daemon never borrows from a sharing machine that is not always on', () => {
    expect(methods(undefined, 0.4)).toEqual(OWN)
    expect(methods(undefined, null)).toEqual(OWN)
    expect(methods(undefined)).toEqual(OWN)
  })
  test('on an older daemon borrows from an always-on machine', () => {
    expect(methods(undefined, 0.97)).toEqual(BORROWED)
    expect(methods(undefined, 0.9)).toEqual(BORROWED)
  })
  test('reads the daemon’s verdict, nothing from an older daemon, and no sharing machine without one', () => {
    expect(lenderVerdict(status({ usable_for_new: true, reason: null }))).toEqual({ usableForNew: true })
    expect(lenderVerdict(status())).toEqual({})
    expect(sharingFrom({ is_broker: false, providers: [], loans: [] } as unknown as LoginBrokerStatus, members(1))).toBeNull()
  })
  test('“Set up” follows the same rule', () => {
    const machines = [fresh(), vps()]
    const view = (usable: boolean) => ({ machines, groups: unifyAccounts(machines), sharing: { machineId: 'vps', machine: 'kdi-vps', usable } }) as unknown as UnifiedView
    const offer = { id: 'new_machine:new', kind: 'new_machine', fingerprint: 'f', machine_id: 'new', machine_name: 'laptop', keys: ['claude-code:w@x.com'], machines: ['vps'] } as Offer
    expect(setupItems(view(true), offer).map((i) => [i.method, i.lender?.account])).toEqual([['borrow', 'a1']])
    expect(setupItems(view(false), offer).map((i) => [i.method, i.lender])).toEqual([['sign_in', undefined]])
  })
})

describe('a machine’s menu', () => {
  const machines = [fresh(), vps()]
  test('chooses and clears without signing the previous machine out, saying when the offer chose', async () => {
    const calls: unknown[] = []
    const client = { call: async (method: string, params: unknown) => { calls.push([method, params]) } } as unknown as Parameters<typeof setSharing>[0]
    await setSharing(client, 'vps')
    await setSharing(client, null)
    await setSharing(client, 'vps', 'always_on')
    expect(calls).toEqual([
      ['login.broker.set', { machine_id: 'vps', sign_out_old: false }],
      ['login.broker.set', { machine_id: null, sign_out_old: false }],
      ['login.broker.set', { machine_id: 'vps', sign_out_old: false, via: 'always_on' }],
    ])
  })
  test('offers sharing on a machine that can, and stopping on the one that shares', () => {
    expect(sharingAction(machines[1]!, machines, null)).toBe('share')
    expect(sharingAction(machines[1]!, machines, 'new')).toBe('share')
    expect(sharingAction(machines[1]!, machines, 'vps')).toBe('stop')
  })
  test('offers nothing offline, on an older daemon, through an older window or on a lone machine', () => {
    expect(sharingAction(vps({ online: false }), machines, 'vps')).toBeNull()
    expect(sharingAction(vps({ features: [] }), machines, null)).toBeNull()
    expect(sharingAction(machines[1]!, [fresh({ features: [] }), vps()], null)).toBeNull()
    expect(sharingAction(machines[0]!, [machines[0]!], null)).toBeNull()
  })
  test('marks the sharing machine only on the sign-ins it lends', () => {
    const all = [fresh({ accounts: [account('claude-code', 'm1', 'w@x.com')] }), vps()]
    const marked = (kind: string, sharing: string | null) => chipsFor(unifyAccounts(all).find((g) => g.kind === kind)!.accounts[0]!, all, sharing).filter((c) => c.lender).map((c) => c.machineId)
    expect(marked('claude-code', 'vps')).toEqual(['vps'])
    expect(marked('claude-code', null)).toEqual([])
    expect(marked('cursor', 'vps')).toEqual([])
  })
})

describe('a failed borrow', () => {
  const view = (error: unknown) => describeProblem(error, { action: 'use kdi-vps’s sign-in' })
  test('offers signing this machine in, whatever failed', () => {
    for (const error of [new Error('boom'), Object.assign(new Error('missing scope'), { code: -32001 })]) {
      expect(signInHereAction(error, view(error), 'laptop')).toEqual({ id: 'sign_in_here', label: 'Sign in on laptop instead' })
    }
  })
  test('takes the daemon’s own words for it', () => {
    const error = Object.assign(new Error('refused'), { data: { problem: { kind: 'permission', subject: 'login_borrow', hint: 'kdi-vps is offline.', action: { id: 'sign_in_here', label: 'Sign in on kdi-box instead', params: { machine_id: 'new', provider: 'claude-code' } } } } })
    expect(signInHereAction(error, view(error), 'laptop').label).toBe('Sign in on kdi-box instead')
  })

  const item: SignInItem = { id: 'new:claude-code:new', machineId: 'new', machine: 'laptop', kind: 'claude-code', method: 'borrow', email: 'w@x.com', lender: { machine: 'kdi-vps', account: 'a1' } }
  const target = () => fresh({ features: [...SHARES, 'accounts.write.v1'] })
  const there = () => ({ machines: [target()] }) as unknown as UnifiedView
  /** An account as `providers.accounts.create` leaves it. */
  const empty = (instance: string, name: string) => summary('claude-code', instance, { name, status: 'signed_out', managed: true, is_default: false })
  type Connect = NonNullable<Parameters<typeof borrow>[2]>
  /** A machine that keeps its accounts, with calls that can be made to fail. */
  const daemon = (fail: Partial<Record<string, (n: number) => boolean>> = {}, have: AccountSummary[] = []) => {
    const calls: [string, any][] = []
    const accounts = [...have]
    const counts: Record<string, number> = {}
    let made = 0
    const client = { call: async (method: string, params: any) => {
      calls.push([method, params])
      const n = (counts[method] = (counts[method] ?? 0) + 1)
      const refused = () => { if (fail[method]?.(n)) throw new Error('refused') }
      if (method === 'providers.accounts.create') {
        const instance = `made${++made}`
        // `create:lost` makes the account, then loses the answer.
        refused()
        accounts.push(empty(instance, params.name))
        if (fail.lost?.(n)) throw new Error('connection closed')
        return { kind: params.kind, instance }
      }
      refused()
      if (method === 'providers.accounts.remove') accounts.splice(accounts.findIndex((a) => a.provider.instance === params.instance), 1)
      if (method === 'providers.accounts.list') return { accounts: [...accounts] }
      return {}
    } }
    return { calls, accounts, methods: () => calls.map(([method]) => method), connect: (() => client) as unknown as Connect }
  }
  const lending = (account: string): SignInItem => ({ ...item, lender: { machine: 'kdi-vps', account } })

  test('takes away the account it made', async () => {
    const machine = daemon({ 'login.broker.bind': () => true })
    await expect(borrow(there(), lending('refused'), machine.connect)).rejects.toThrow('refused')
    expect(machine.methods()).toEqual(['providers.accounts.list', 'providers.accounts.create', 'login.broker.bind', 'providers.accounts.remove'])
    expect(machine.accounts).toEqual([])
  })
  test('keeps an account the machine already had', async () => {
    const machine = daemon({ 'login.broker.bind': () => true })
    await expect(borrow(there(), { ...item, instance: 'old' }, machine.connect)).rejects.toThrow('refused')
    expect(machine.methods()).toEqual(['login.broker.bind'])
  })
  test('an account it couldn’t take away is the one the next try uses', async () => {
    const machine = daemon({ 'login.broker.bind': (n) => n === 1, 'providers.accounts.remove': () => true })
    await expect(borrow(there(), lending('stuck'), machine.connect)).rejects.toThrow('refused')
    await borrow(there(), lending('stuck'), machine.connect)
    expect(machine.methods().filter((m) => m === 'providers.accounts.create')).toHaveLength(1)
    expect(machine.calls.filter(([m]) => m === 'login.broker.bind').map(([, p]) => p.instance)).toEqual(['made1', 'made1'])
    expect(machine.accounts).toHaveLength(1)
    // Borrowed now: nothing left to take away.
    await discardBorrow(lending('stuck'), machine.connect)
    expect(machine.accounts).toHaveLength(1)
  })
  test('closing the sheet later takes away what couldn’t be then', async () => {
    const machine = daemon({ 'login.broker.bind': () => true, 'providers.accounts.remove': (n) => n === 1 })
    await expect(borrow(there(), lending('later'), machine.connect)).rejects.toThrow('refused')
    expect(machine.accounts).toHaveLength(1)
    await discardBorrow(lending('later'), machine.connect)
    expect(machine.accounts).toEqual([])
  })
  test('an account made just as the connection dropped is taken away', async () => {
    const machine = daemon({ lost: () => true })
    await expect(borrow(there(), lending('lost'), machine.connect)).rejects.toThrow('connection closed')
    expect(machine.accounts).toEqual([])
    expect(machine.methods()).not.toContain('login.broker.bind')
  })
  test('uses an empty account an earlier try left, instead of making another', async () => {
    const machine = daemon({}, [empty('left', 'w@x.com')])
    await borrow(there(), lending('leftover'), machine.connect)
    expect(machine.methods()).not.toContain('providers.accounts.create')
    expect(machine.calls.find(([m]) => m === 'login.broker.bind')![1]).toMatchObject({ instance: 'left' })
  })
  test('uses the account that already borrows this sign-in', async () => {
    const bound = { ...empty('bound', 'Work'), status: 'signed_in' as const, broker: { machine_id: 'vps', machine_name: 'kdi-vps', broker_account: 'again', state: 'borrowing' as const } }
    const machine = daemon({}, [bound])
    await borrow(there(), lending('again'), machine.connect)
    expect(machine.methods()).toEqual(['providers.accounts.list', 'login.broker.bind'])
  })
  test('cancelled before it is bound, it binds nothing and leaves nothing', async () => {
    const cancel = new AbortController()
    const machine = daemon()
    const connect = (() => {
      const client = machine.connect('new')
      return { call: async (method: string, params: unknown) => { const answer = await client.call(method as never, params as never); if (method === 'providers.accounts.create') cancel.abort(); return answer } }
    }) as unknown as Connect
    await expect(borrow(there(), lending('cancelled'), connect, cancel.signal)).rejects.toThrow()
    expect(machine.methods()).not.toContain('login.broker.bind')
    expect(machine.accounts).toEqual([])
  })
  test('asks nothing of a machine that must update first', async () => {
    const machine = daemon()
    await expect(borrow({ machines: [fresh({ features: SHARES })] } as unknown as UnifiedView, lending('old-daemon'), machine.connect)).rejects.toThrow('Update Kybern on laptop')
    expect(machine.calls).toEqual([])
  })
  test('a login that borrows stops before it signs in itself', async () => {
    const broker = (state: AccountBroker['state']): AccountBroker => ({ machine_id: 'vps', machine_name: 'kdi-vps', broker_account: 'a1', state })
    const view = { machines: [fresh({ accounts: [account('claude-code', 'away', 'w@x.com', { broker: broker('broker_offline') }), account('claude-code', 'lends', 'l@x.com', { broker: broker('lending') }), account('claude-code', 'own', 'o@x.com')] })] } as unknown as UnifiedView
    const calls: unknown[] = []
    const connect = (() => ({ call: async (method: string, params: unknown) => { calls.push([method, params]) } })) as unknown as NonNullable<Parameters<typeof stopBorrowing>[2]>
    for (const instance of ['away', 'lends', 'own', 'default', undefined]) await stopBorrowing(view, { machineId: 'new', kind: 'claude-code', instance }, connect)
    expect(calls).toEqual([['login.broker.bind', { provider: 'claude-code', instance: 'away', broker_account: null }]])
  })
})

describe('the “now the default” toast', () => {
  const have = (machineId: string, name: string, patch: Partial<MachineAccounts> = {}) => machine(machineId, name, [account('claude-code', 'a1', 'w@x.com')], { features: ['accounts.shared.v1'], ...patch })
  const machines = [have('mac', 'MacBook', { isLocal: true }), have('fedora', 'fedora'), have('old', 'old-box', { features: [] }), have('away', 'SatyaMas', { online: false }), machine('bare', 'bare', [], { features: ['accounts.shared.v1'] })]
  const work = unifyAccounts(machines)[0]!.accounts[0]!

  test('names only the machines that took it', () => {
    const takers = defaultTakers({ machines }, work)
    expect(takers).toEqual({ took: ['MacBook', 'fedora'], later: ['SatyaMas'] })
    expect(defaultMessage('Work', 'Claude Code', takers.took, { later: takers.later }, machines.length)).toBe('Work is now the default for Claude Code on MacBook and fedora. SatyaMas follows when it’s back.')
  })
  test('names none when every machine took it', () => {
    expect(defaultMessage('Work', 'Claude Code', ['MacBook'], {}, 1)).toBe('Work is now the default for Claude Code')
  })
  test('claims nothing when none could yet', () => {
    expect(defaultMessage('Work', 'Claude Code', [], { later: ['SatyaMas', 'fedora'] }, 3)).toBe('Work is saved as the default for Claude Code. SatyaMas and fedora follow when they’re back.')
    expect(defaultMessage('Work', 'Claude Code', ['MacBook'], { kept: ['SatyaMas'] }, 2)).toBe('Work is now the default for Claude Code on MacBook. SatyaMas keeps its default until it’s back.')
  })
})
