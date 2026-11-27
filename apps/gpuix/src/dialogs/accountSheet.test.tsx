// The Add account sheet against made-up machines: it never calls a machine that must update first, never waits forever
// on a sign-in that is gone, keeps the default every machine shares, and lets a handoff's port go when it closes.
import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import { RpcCallError } from '../../../../packages/kybern-client/src/client.ts'
import type { AccountLogin, AccountsShared, AccountSummary, DaemonUpdate } from '../../../../packages/kybern-client/src/types.ts'
import type { SignInItem } from '../accounts/queue.ts'
import type { MachineAccounts } from '../accounts/unified.ts'
import { harness } from './gpuixHarness.tsx'

const real = {
  store: { ...(await import('../accounts/store.ts')) },
  state: { ...(await import('../state.ts')) },
  network: { ...(await import('../machines/network.ts')) },
  external: { ...(await import('../settings/external.ts')) },
}

type Handlers = Record<string, (params: any) => unknown>
function fakeClient(handlers: Handlers = {}, features: string[] = []) {
  const calls: [string, any][] = []
  return {
    calls,
    methods: () => calls.map(([method]) => method),
    info: { features, scopes: [] },
    call: async (method: string, params: unknown) => { calls.push([method, params]); return handlers[method]?.(params) ?? {} },
    onNotification: () => () => {},
  }
}

const OLD = { features: ['network.v1'], scopes: ['orchestration_read', 'orchestration_operate'] }
const NEW = { features: ['accounts.write.v1', 'antigravity.accounts.v1', 'accounts.shared.v1'], scopes: ['orchestration_read', 'accounts_write'] }
/** A machine as the account lists read it: away until it has said something about itself. */
const machineAccounts = (machineId: string, features: string[] | undefined): MachineAccounts => ({ machineId, name: machineId, isLocal: machineId === 'mac', online: !!features, state: features ? 'ready' : 'unreachable', accounts: [], providers: null, limits: [], globalLimits: [], features: features ?? [] })

interface World {
  /** The accounts the other machine lists. */
  accounts?: AccountSummary[]
  info: Record<string, { features: string[]; scopes: string[]; version?: string }>
  clients: Record<string, ReturnType<typeof fakeClient>>
  own: ReturnType<typeof fakeClient>
}
let world: World
let updates: string[] = []
let opened: string[] = []

mock.module('../accounts/store.ts', () => ({
  ...real.store,
  primaryId: () => 'mac',
  computerId: () => 'mac',
  infoOf: (id: string) => world.info[id] ?? null,
  clientOf: (id: string) => { const client = world.clients[id]; if (!client) throw new Error(`${id} is offline`); return client },
  readMachine: async () => {},
  refreshOfferInputs: async () => {},
  refreshAllAccounts: async () => {},
  useAccountsEverywhere: () => {
    const machines = [machineAccounts('mac', ['accounts.shared.v1']), { ...machineAccounts('fedora', world.info.fedora?.features), accounts: world.accounts ?? [] }]
    return { machines, groups: [], shared: {}, supportsShared: true, primaryId: 'mac', legacy: false, loaded: true, sharing: null }
  },
}))
mock.module('../state.ts', () => ({ ...real.state, getClient: () => world.own }))
mock.module('../machines/network.ts', () => ({
  ...real.network,
  retryMachineUpdate: async (id: string): Promise<Pick<DaemonUpdate, 'status'>> => { updates.push(id); return { status: 'waiting' } },
}))
mock.module('../settings/external.ts', () => ({ ...real.external, openExternal: async (url: string) => { opened.push(url) } }))

const { Account } = await import('./Account.tsx')
const { ThemeProvider } = await import('../ui.tsx')

afterAll(() => {
  mock.module('../accounts/store.ts', () => real.store)
  mock.module('../state.ts', () => real.state)
  mock.module('../machines/network.ts', () => real.network)
  mock.module('../settings/external.ts', () => real.external)
})

let mounted: ReturnType<typeof harness> | null = null
afterEach(() => { mounted?.close(); mounted = null; updates = []; opened = [] })

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms))
const item: SignInItem = { id: 'fedora:claude-code:new', machineId: 'fedora', machine: 'fedora', kind: 'claude-code', method: 'sign_in' }
function open(items: SignInItem[] = [item]) {
  const h = harness()
  mounted = h
  const render = () => h.render(<ThemeProvider><Account close={() => {}} items={items} /></ThemeProvider>)
  render()
  const click = (testId: string) => { const id = h.find(testId); expect(id, testId).toBeDefined(); h.fire(id!, { eventType: 'click' }) }
  return { h, render, click }
}
const login = (patch: Partial<AccountLogin> = {}): AccountLogin => ({ id: 'l1', kind: 'claude-code', mode: 'paste', phase: 'waiting', url: 'https://claude.com/x', expires_at: '2027-01-01T00:00:00Z', ...patch })

describe('a machine that must update first', () => {
  test('says to update it, calls nothing there, and signs in once it has', async () => {
    const fedora = fakeClient({ 'providers.accounts.login.start': () => login() })
    world = { info: { fedora: OLD }, clients: { fedora }, own: fakeClient() }
    const sheet = open()
    await settle()
    expect(sheet.h.text()).toContain('Update Kybern on fedora')
    expect(fedora.calls).toEqual([])
    sheet.click('account-update')
    await settle()
    expect(updates).toEqual(['fedora'])
    expect(sheet.h.text()).toContain('fedora updates when its running work finishes.')
    // It comes back on the new version.
    world.info.fedora = NEW
    sheet.render()
    await settle()
    expect(fedora.methods()).toContain('providers.accounts.login.start')
    expect(sheet.h.find('account-code')).toBeDefined()
  })

  test('a borrow there makes no account', async () => {
    const fedora = fakeClient()
    world = { info: { fedora: OLD }, clients: { fedora }, own: fakeClient() }
    open([{ ...item, method: 'borrow', email: 'w@x.com', lender: { machine: 'vps', account: 'a1' } }])
    await settle()
    expect(fedora.calls).toEqual([])
  })
})

describe('a sign-in that can’t be followed', () => {
  test('one the machine no longer knows ends with Try again', async () => {
    const fedora = fakeClient({
      'providers.accounts.login.start': () => login(),
      'providers.accounts.login.get': () => { throw new RpcCallError({ code: -32602, message: 'This sign-in has ended. Start again.' }) },
    })
    world = { info: { fedora: NEW }, clients: { fedora }, own: fakeClient() }
    const sheet = open()
    await settle(1200)
    expect(sheet.h.text()).toContain('The sign-in ended')
    expect(sheet.h.find('account-retry')).toBeDefined()
    expect(sheet.h.find('account-show-terminal')).toBeUndefined()
  })

  test('a machine that is away offers Try again, which works once it is back', async () => {
    world = { info: {}, clients: {}, own: fakeClient() }
    const sheet = open()
    await settle()
    expect(sheet.h.text()).toContain('fedora is offline')
    const fedora = fakeClient({ 'providers.accounts.login.start': () => login() })
    world.clients.fedora = fedora
    world.info.fedora = NEW
    sheet.click('account-retry')
    await settle()
    expect(fedora.methods()).toEqual(['providers.accounts.login.start'])
  })
})

describe('the default', () => {
  const finished = async (shared: AccountsShared) => {
    const fedora = fakeClient({
      'providers.accounts.login.start': () => login({ phase: 'signed_in', identity: { email: 'n@x.com' } }),
      'providers.accounts.login.finish': () => ({ kind: 'claude-code', instance: 'l1' }),
    })
    world = { info: { fedora: NEW }, clients: { fedora }, own: fakeClient({ 'settings.get': () => ({ accounts_shared: shared }) }) }
    open()
    await settle()
    return fedora.calls.find(([method]) => method === 'providers.accounts.login.finish')?.[1]
  }
  test('a machine’s first account leaves the default every machine shares alone', async () => {
    expect(await finished({ defaults: { 'claude-code': 'claude-code:w@x.com' } })).toMatchObject({ id: 'l1', make_default: false })
  })
  test('with no shared default yet, it becomes it', async () => {
    expect(await finished({})).toMatchObject({ id: 'l1', make_default: true })
  })
})

describe('a sign-in again that went to another account', () => {
  const account = (instance: string, name: string, email: string, color: string): AccountSummary => ({ provider: { kind: 'claude-code', instance }, name, color, identity: { email }, status: 'signed_in', is_default: false, projects: [], managed: true, can_sign_out: true })
  const again: SignInItem = { ...item, id: 'fedora:claude-code:a1', instance: 'a1', email: 'w@x.com' }
  const done = login({ phase: 'signed_in', instance: 'a1', identity: { email: 'me@x.com' }, previous_email: 'w@x.com' })
  const signedIn = async ({ version = '0.27.2', patch = {}, handlers = {} }: { version?: string; patch?: Partial<AccountLogin>; handlers?: Handlers } = {}) => {
    const fedora = fakeClient({
      'providers.accounts.login.start': () => ({ ...done, ...patch }),
      'providers.accounts.login.finish': () => ({ kind: 'claude-code', instance: 'a1' }),
      ...handlers,
    })
    world = { accounts: [account('a1', 'Work', 'w@x.com', 'green'), account('a2', 'Home', 'me@x.com', 'blue')], info: { fedora: { ...NEW, version } }, clients: { fedora }, own: fakeClient() }
    const sheet = open([again])
    await settle()
    expect(sheet.h.text()).toContain('fedora signed in as me@x.com')
    return { ...sheet, fedora, finishes: () => fedora.calls.filter(([method]) => method === 'providers.accounts.login.finish').map(([, params]) => params) }
  }

  test('Keep tells the machine to save it, under the account’s own name and colour', async () => {
    const sheet = await signedIn()
    expect(sheet.finishes()).toEqual([])
    sheet.click('account-keep')
    await settle()
    expect(sheet.finishes()).toEqual([{ id: 'l1', name: 'Work', color: 'green', make_default: false }])
    expect(sheet.h.text()).toContain('Signed in as me@x.com')
    sheet.h.close()
    mounted = null
    expect(sheet.fedora.methods()).not.toContain('providers.accounts.login.cancel')
  })

  test('on an older daemon, which saved it already, Keep calls nothing', async () => {
    const sheet = await signedIn({ version: '0.27.1' })
    sheet.click('account-keep')
    await settle()
    expect(sheet.finishes()).toEqual([])
    expect(sheet.h.text()).toContain('Signed in as me@x.com')
  })

  test('a Keep that fails says so, and Try again keeps it', async () => {
    let tries = 0
    const sheet = await signedIn({ handlers: { 'providers.accounts.login.finish': () => { if (!tries++) throw new Error('boom'); return { kind: 'claude-code', instance: 'a1' } } } })
    sheet.click('account-keep')
    await settle()
    expect(sheet.h.text()).toContain('Couldn’t save the account')
    sheet.click('account-retry')
    await settle()
    expect(sheet.finishes()).toHaveLength(2)
    expect(sheet.h.text()).toContain('Signed in as me@x.com')
  })

  test('Try again drops it and starts over', async () => {
    const sheet = await signedIn()
    sheet.click('account-retry')
    await settle()
    expect(sheet.fedora.methods().filter((method) => method.startsWith('providers.accounts.login.'))).toEqual(['providers.accounts.login.start', 'providers.accounts.login.cancel', 'providers.accounts.login.start'])
    expect(sheet.finishes()).toEqual([])
  })

  test('an account that is already added can’t be kept', async () => {
    const sheet = await signedIn({ patch: { duplicate_of: 'a2' } })
    expect(sheet.h.text()).toContain('It’s already added as Home.')
    expect(sheet.h.find('account-keep')).toBeUndefined()
    expect(sheet.h.find('account-retry')).toBeDefined()
  })
})

describe('“Authorize”', () => {
  test('closing the sheet lets this computer’s port go', async () => {
    const handoff = 'accounts.login.handoff.v1'
    const waiting = login({ mode: 'browser', handoff: { port: 54321, path: '/callback' } })
    const fedora = fakeClient({ 'providers.accounts.login.start': () => waiting, 'providers.accounts.login.get': () => waiting })
    const own = fakeClient({ 'providers.accounts.login.handoff': () => ({ url: 'https://claude.com/authorize', expires_at: '2027-01-01T00:00:00Z' }) }, [handoff])
    world = { info: { fedora: { ...NEW, features: [...NEW.features, handoff] } }, clients: { fedora }, own }
    const sheet = open()
    await settle()
    sheet.click('account-authorize')
    await settle()
    expect(opened).toEqual(['https://claude.com/authorize'])
    expect(own.methods()).not.toContain('providers.accounts.login.handoff.cancel')
    sheet.h.close()
    mounted = null
    await settle()
    expect(own.calls.filter(([method]) => method === 'providers.accounts.login.handoff.cancel')).toEqual([['providers.accounts.login.handoff.cancel', { login_id: 'l1' }]])
  })
})
