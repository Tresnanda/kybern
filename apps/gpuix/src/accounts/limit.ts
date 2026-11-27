// A thread at its account's limit, or whose account isn't signed in on its machine. Kybern never moves a thread to
// another account on its own: these are the choices behind the one tap. Pure.
import { CLI_INSTANCE, withoutSignIn } from '../shared/lib/accounts.ts'
import type { ProviderInstance } from '../../../../packages/kybern-client/src/types.ts'
import { accountAt, isUsable, leftOf, suggestAccount, type HarnessGroup, type MachineAccounts, type UnifiedAccount } from './unified.ts'

export interface SwitchChoice {
  /** The login on the thread's machine. */
  instance: string
  account: UnifiedAccount
  /** What is left of its tightest limit, when known. */
  left: number | null
}

export interface SwitchChoices {
  choices: SwitchChoice[]
  /** Preselected: the daemon's suggestion, else the most limit left among the eligible. Null when none is eligible. */
  suggested: SwitchChoice | null
  /** Accounts signed in elsewhere but not on the thread's machine: offered as a sign-in there. */
  elsewhere: UnifiedAccount[]
}

const groupOf = (groups: readonly HarnessGroup[], provider: ProviderInstance) => groups.find((g) => g.kind === provider.kind)?.accounts ?? []

/** The login of `account` a thread on `machineId` would use: its named one, else the terminal login. */
function usableLogin(account: UnifiedAccount, machineId: string) {
  const there = account.presences.filter((p) => p.machineId === machineId && isUsable(p.state))
  return there.find((p) => !p.terminal) ?? there[0]
}

export function switchChoices(groups: readonly HarnessGroup[], machineId: string, current: ProviderInstance, suggestion: string | null | undefined, now: number): SwitchChoices {
  const own = accountAt(groups, machineId, current)
  const others = groupOf(groups, current).filter((account) => account !== own && !account.presences.some((p) => p.machineId === machineId && p.instance === current.instance))
  const choices = others.flatMap((account): SwitchChoice[] => {
    const login = usableLogin(account, machineId)
    return login ? [{ instance: login.instance, account, left: leftOf(account, now) }] : []
  })
  const candidates = [
    { instance: current.instance || CLI_INSTANCE, limits: own?.limit?.entry, manualOnly: false, usable: true },
    ...choices.map((c) => ({ instance: c.instance, limits: c.account.limit?.entry, manualOnly: c.account.manualOnly, usable: true })),
  ]
  const wanted = choices.find((c) => c.instance === suggestion) ? suggestion : suggestAccount(candidates, current.instance || CLI_INSTANCE, now)
  const elsewhere = others.filter((account) => account.key && !usableLogin(account, machineId) && account.presences.some((p) => p.machineId !== machineId && isUsable(p.state)))
  return { choices, suggested: choices.find((c) => c.instance === wanted) ?? null, elsewhere }
}

export interface AccountAway {
  /** The login the thread's next message would use. */
  provider: ProviderInstance
  /** The thread's account, when known on any machine. */
  account?: UnifiedAccount
  /** Its name, when known. */
  name: string | null
}

/** Whether the machine's account list says the login can't be used: removed there, signed out, or its lender away. */
function listedAway(machines: readonly MachineAccounts[], machineId: string, provider: ProviderInstance, instance: string): boolean {
  const machine = machines.find((m) => m.machineId === machineId)
  if (!machine || machine.state !== 'ready' || !machine.online) return false
  const summary = machine.accounts.find((a) => a.provider.kind === provider.kind && a.provider.instance === instance)
  // An agent the daemon didn't list at all says nothing about the account.
  if (!summary) return machine.accounts.some((a) => a.provider.kind === provider.kind)
  if (summary.broker) return summary.broker.state !== 'borrowing' && summary.broker.state !== 'lending'
  return summary.status === 'signed_out' || summary.status === 'needs_sign_in'
}

/**
 * The thread's account isn't usable on its machine. A daemon that knows says so (`account_unavailable`); for an older
 * one the machine's account list decides: null while it hasn't answered, for agents without a sign-in, and for a
 * terminal login whose state is unknown.
 */
export function accountAway(machines: readonly MachineAccounts[], groups: readonly HarnessGroup[], machineId: string, provider: ProviderInstance, unavailable?: boolean): AccountAway | null {
  if (withoutSignIn(provider.kind)) return null
  const instance = provider.instance || CLI_INSTANCE
  if (!(unavailable ?? listedAway(machines, machineId, provider, instance))) return null
  const summary = machines.find((m) => m.machineId === machineId)?.accounts.find((a) => a.provider.kind === provider.kind && a.provider.instance === instance)
  const account = accountAt(groups, machineId, { kind: provider.kind, instance })
  return { provider: { kind: provider.kind, instance }, ...(account && !account.terminalOnly ? { account } : {}), name: account && !account.terminalOnly ? account.name : summary && instance !== CLI_INSTANCE ? summary.name : null }
}
