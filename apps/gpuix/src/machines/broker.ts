// The login broker as Settings › Accounts reads it (ADE-86 S4, design §9.4): `login.broker.status` from the machine the user
// is at, and the actions on it. One store; it reads while the page shows it. The words come from the shared client
// (`loginBroker.ts`), which also runs "Sign in on all machines".
import { useEffect, useSyncExternalStore } from 'react'
import type { LoginBrokerSetResult, LoginBrokerStatus, MachineId, ProviderKind } from '../../../../packages/kybern-client/src/types.ts'
import { planSignInAll, runSignInAll, driveLogin, type SignInAllRow } from '../../../../packages/kybern-client/src/loginBroker.ts'
import { initialLoginMode } from '../shared/lib/accounts.ts'
import { getClient } from '../state.ts'
import { machineHub } from './index.ts'
import { refreshAccounts } from '../usage/accounts.ts'
import { refreshNetwork } from './network.ts'

export interface BrokerState {
  status: LoginBrokerStatus | null
  /// The daemon is older than the login broker.
  unavailable: boolean
  error: string
  /// An action is running: the harness it is for, or `move`.
  busy: string | null
  /// What the last move did.
  moved: LoginBrokerSetResult | null
}

const EMPTY: BrokerState = { status: null, unavailable: false, error: '', busy: null, moved: null }
let state: BrokerState = EMPTY
const listeners = new Set<() => void>()
const emit = (patch: Partial<BrokerState>) => { state = { ...state, ...patch }; for (const listener of listeners) listener() }
export const getBroker = () => state
/** Tests: forget everything. */
export function resetBroker() { state = EMPTY; reading = false }

const text = (error: unknown) => (error instanceof Error ? error.message : String(error))

let reading = false
export async function refreshBroker(): Promise<void> {
  const client = getClient()
  if (!client || client.status !== 'open' || reading) return
  reading = true
  try {
    const status = await client.call('login.broker.status', {})
    if (getClient() === client) emit({ status, unavailable: false, error: '' })
  } catch (error) {
    if (getClient() === client) emit({ unavailable: /not found|unknown method|-32601/i.test(text(error)), error: text(error) })
  } finally { reading = false }
}

async function act<T>(busy: string, run: () => Promise<T>): Promise<T> {
  emit({ busy, error: '' })
  try { return await run() } catch (error) { emit({ error: text(error) }); throw error } finally { emit({ busy: null }) }
}

/** "Use VPS's sign-in": a named account here that signs in through the broker's account. */
export function useBrokerSignIn(kind: ProviderKind, harness: string, brokerName: string, brokerAccount: string): Promise<void> {
  return act(kind, async () => {
    const client = getClient()
    if (!client) throw new Error('Not connected')
    const accounts = await client.call('providers.accounts.list', { kind })
    const existing = accounts.accounts.find((account) => account.broker)
    const instance = existing?.provider.instance ?? (await client.call('providers.accounts.create', { kind, name: `${harness} (${brokerName})` })).instance
    emit({ status: await client.call('login.broker.bind', { provider: kind, instance, broker_account: brokerAccount }) })
    await refreshAccounts()
  })
}

/** "Sign in here instead": the account stops using the broker and signs in on this machine. */
export function signInHereInstead(kind: ProviderKind, instance: string): Promise<void> {
  return act(kind, async () => {
    const client = getClient()
    if (!client) throw new Error('Not connected')
    emit({ status: await client.call('login.broker.bind', { provider: kind, instance, broker_account: null }) })
    await refreshAccounts()
  })
}

/** Move the broker (or clear it): the new one lends first, the members borrow from it, and only then does the old one sign out. */
export function moveBroker(machineId: MachineId | null): Promise<LoginBrokerSetResult> {
  return act('move', async () => {
    const client = getClient()
    if (!client) throw new Error('Not connected')
    const result = await client.call('login.broker.set', { machine_id: machineId, sign_out_old: true })
    emit({ status: result.status, moved: result })
    void refreshNetwork()
    void refreshAccounts()
    return result
  })
}

export function useBroker(): BrokerState {
  const value = useSyncExternalStore((fn) => { listeners.add(fn); return () => { listeners.delete(fn) } }, () => state)
  useEffect(() => { void refreshBroker() }, [])
  return value
}

// ── Sign in on all machines ──────────────────────────────────────────────────

export interface SignInAllState { kind: ProviderKind | null; rows: SignInAllRow[]; running: boolean; controller: AbortController | null }
let all: SignInAllState = { kind: null, rows: [], running: false, controller: null }
const allListeners = new Set<() => void>()
const emitAll = (patch: Partial<SignInAllState>) => { all = { ...all, ...patch }; for (const listener of allListeners) listener() }
export const useSignInAll = (): SignInAllState => useSyncExternalStore((fn) => { allListeners.add(fn); return () => { allListeners.delete(fn) } }, () => all)
export const closeSignInAll = () => { all.controller?.abort(); emitAll({ kind: null, rows: [], running: false, controller: null }) }

/** Each machine that lacks the harness' sign-in signs in with its own flow, one after another. */
export async function startSignInAll(kind: ProviderKind, harness: string): Promise<void> {
  const hub = machineHub()
  const machines = await Promise.all(hub.connections().map(async (connection) => {
    const { machineId, name } = connection.record
    const online = connection.status === 'online' || connection.status === 'relaying'
    let signedIn: boolean | undefined
    if (online) {
      try { signedIn = (await hub.clientFor(machineId).call('providers.accounts.list', { kind })).accounts.some((account) => account.status === 'signed_in') } catch { signedIn = undefined }
    }
    return { machineId, name, online, signedIn }
  }))
  const controller = new AbortController()
  emitAll({ kind, rows: planSignInAll(machines), running: true, controller })
  const rows = await runSignInAll(all.rows, async (row, update) => {
    const client = hub.clientFor(row.machineId)
    const remote = row.machineId !== hub.localMachineId
    return driveLogin(client, { kind, mode: initialLoginMode(kind, remote), accountName: `${harness} (${row.name})`, signal: controller.signal }, update)
  }, { signal: controller.signal, onChange: (rows) => emitAll({ rows }) })
  emitAll({ rows, running: false })
  void refreshAccounts()
}

/** The person pastes the code their sign-in page showed, for the machine whose step this is. */
export async function submitSignInCode(machineId: MachineId, loginId: string, code: string): Promise<void> {
  await machineHub().clientFor(machineId).call('providers.accounts.login.input', { id: loginId, code })
}
