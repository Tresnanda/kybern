// One sign-in per machine, one after another: what "Add account", "Set up" and a machine's chip all start. Each machine
// gets its own login (a copied login breaks both), or borrows a shared one where that is possible. Pure: planning and the
// queue's state; `dialogs/Account.tsx` runs the steps.
import { initialLoginMode } from '../shared/lib/accounts.ts'
import { problemOf } from '../../../../packages/kybern-client/src/problem.ts'
import type { ProblemView } from '../../../../packages/kybern-client/src/problems.ts'
import { ACCOUNTS_WRITE_FEATURE, type AccountLogin, type AccountLoginMode, type AccountsShared, type AccountSummary, type DaemonUpdate, type LendableAccount, type MachineId, type ProviderKind } from '../../../../packages/kybern-client/src/types.ts'
import { LENDABLE_KINDS } from './offers.ts'
import { keyOf, standings, isUsable, type MachineAccounts, type UnifiedAccount } from './unified.ts'

export interface SignInItem {
  id: string
  machineId: MachineId
  machine: string
  kind: ProviderKind
  /** `borrow`: use the sharing machine's sign-in, no browser. */
  method: 'sign_in' | 'borrow'
  /** Sign an existing login in again: a named account, or `default` for the terminal login. */
  instance?: string
  /** Antigravity: this computer's own `agy` login, in a terminal. */
  ownLogin?: boolean
  /** Antigravity: a new named account with a profile of its own. */
  named?: boolean
  /** The account's name; empty names it after its email. */
  name?: string
  /** The email this sign-in should end on (an account other machines already have). */
  email?: string
  color?: string
  /** `borrow`: whose sign-in, and which of its accounts. */
  lender?: { machine: string; account: string }
  /** Use an existing agent folder instead of a new one (only on the machine it is on). */
  directory?: string
}

/**
 * How a new sign-in on a machine is done. `remote`: the browser on this computer cannot reach that machine's sign-in by
 * itself, so with `handoff` ("Authorize only", `adapter.ts` `canHandoff`) this computer's daemon forwards the redirect,
 * and without it the person pastes or enters a code.
 */
export function loginModeFor(item: Pick<SignInItem, 'kind' | 'ownLogin' | 'instance' | 'named'>, remote: boolean, handoff = false): AccountLoginMode {
  if (item.ownLogin) return 'terminal'
  if (item.kind === 'antigravity') return 'paste'
  if (remote && handoff) return 'browser'
  return initialLoginMode(item.kind, remote)
}

/** The code to fall back to when a handoff can't be done: Codex's device code, else a pasted code. */
export const fallbackModeFor = (kind: ProviderKind): AccountLoginMode => initialLoginMode(kind, true)

export interface AddRequest {
  kind: ProviderKind
  name?: string
  /** The ticked machines, this computer's first. */
  machines: readonly Pick<MachineAccounts, 'machineId' | 'name' | 'accounts'>[]
  /** The machine whose daemon runs on this computer: Antigravity's own login can be signed in there. */
  computer: MachineId | null
  /** An existing folder, for this window's machine only. */
  directory?: string
}

/** "Add account": one sign-in on each ticked machine. */
export function planAdd({ kind, name, machines, directory }: AddRequest): SignInItem[] {
  const label = name?.trim() || undefined
  return machines.map((machine) => {
    const item: SignInItem = { id: `${machine.machineId}:${kind}:new`, machineId: machine.machineId, machine: machine.name, kind, method: 'sign_in', ...(label ? { name: label } : {}) }
    // Adding an account always makes a new one with its own profile. It never signs in the computer's own `agy` login:
    // a Keychain Kybern can't read quietly looks signed out, and that sign-in replaced the person's own login (0.27.1).
    if (kind === 'antigravity') item.named = true
    if (directory && machines.length === 1) item.directory = directory
    return item
  })
}

/**
 * A computer's own `agy` login is signed in only when the person asked for that terminal login by name (`ownLogin`).
 * Any other Antigravity sign-in that names no account of its own adds a new named one: a sign-in of the computer's own
 * login would replace whoever is signed in there.
 */
export function keepOwnAntigravityLogin(item: SignInItem): SignInItem {
  if (item.kind !== 'antigravity' || item.ownLogin || (item.instance && item.instance !== 'default')) return item
  const { instance: _, ...rest } = item
  return { ...rest, named: true }
}

/** Sign `account` in on one machine: its signed-out login there, else a new one. */
export function planOnMachine(account: UnifiedAccount, machine: Pick<MachineAccounts, 'machineId' | 'name'>): SignInItem {
  const standing = standings(account).find((s) => s.machineId === machine.machineId)
  const named = standing?.presences.find((p) => !p.terminal)
  const existing = named ?? (account.kind === 'antigravity' ? undefined : standing?.presences[0])
  const item: SignInItem = {
    id: `${machine.machineId}:${account.kind}:${existing?.instance ?? 'new'}:${account.id}`,
    machineId: machine.machineId,
    machine: machine.name,
    kind: account.kind,
    method: 'sign_in',
    ...(existing ? { instance: existing.instance } : {}),
    ...(account.key && account.name !== account.email ? { name: account.name } : {}),
    ...(account.email ? { email: account.email } : {}),
    ...(account.color ? { color: account.color } : {}),
  }
  if (account.kind === 'antigravity' && !existing) item.named = true
  return item
}

/** The shared sign-in that can stand in for `account` on another machine: only from a sharing machine that is usable for
 *  new set-ups and has it. */
export function lenderFor(account: Pick<UnifiedAccount, 'kind' | 'email' | 'presences'>, sharing: { machineId: MachineId; machine: string; usable: boolean; lendable: readonly LendableAccount[] } | null, target: MachineId): SignInItem['lender'] | undefined {
  if (!sharing?.usable || sharing.machineId === target || !LENDABLE_KINDS.includes(account.kind) || !account.email) return
  const wanted = account.email.toLowerCase()
  const offered = sharing.lendable.find((a) => a.provider === account.kind && a.email?.toLowerCase() === wanted)
  return offered ? { machine: sharing.machine, account: offered.account } : undefined
}

/** "Set up" on a machine: every account it is missing, borrowed where possible, else signed in one after another. */
export function planSetup(accounts: readonly UnifiedAccount[], machine: Pick<MachineAccounts, 'machineId' | 'name'>, sharing: Parameters<typeof lenderFor>[1]): SignInItem[] {
  const items = accounts
    .filter((account) => !standings(account).some((s) => s.machineId === machine.machineId && isUsable(s.state)))
    .map((account): SignInItem => {
      const item = planOnMachine(account, machine)
      const lender = lenderFor(account, sharing, machine.machineId)
      return lender ? { ...item, method: 'borrow', lender } : item
    })
  // Borrowed ones need no clicks: they go first, so the browser steps come together at the end.
  return [...items.filter((item) => item.method === 'borrow'), ...items.filter((item) => item.method === 'sign_in')]
}

/** The local account on a machine that already has this email, to borrow into rather than create another. */
export function existingFor(accounts: readonly AccountSummary[], kind: ProviderKind, email: string | undefined): AccountSummary | undefined {
  if (!email) return
  const key = `${kind}:${email.toLowerCase()}`
  return accounts.find((a) => a.provider.kind === kind && a.provider.instance !== 'default' && keyOf(a) === key)
}

// ── Machines that must update first ──────────────────────────────────────────

/**
 * Whether the daemon behind a connection refuses account sign-ins and borrows from it. From 0.27.2 they need
 * `accounts:write` (`accounts.write.v1`); an older daemon asks for `access:write`, which a connection to another machine
 * doesn't carry. False while nothing is known about the daemon.
 */
export function needsAccountsUpdate(info: { features?: readonly string[]; scopes?: readonly string[] } | null | undefined): boolean {
  if (!info) return false
  return !info.features?.includes(ACCOUNTS_WRITE_FEATURE) && !info.scopes?.some((scope) => scope === 'accounts_write' || scope === 'access_write')
}

/** The same for a machine of the account lists: unknown until it has answered. This computer is never asked to. */
export function signInNeedsUpdate(machine: Pick<MachineAccounts, 'machineId' | 'state' | 'features' | 'scopes'> | undefined, computer: MachineId | null): boolean {
  if (!machine || machine.machineId === computer || (machine.state !== 'ready' && machine.state !== 'legacy')) return false
  return needsAccountsUpdate(machine)
}

/** What "Update" on such a machine came to, in a sentence. */
export function updateLine(update: Pick<DaemonUpdate, 'status'>, machine: string): string {
  switch (update.status) {
    case 'waiting': return `${machine} updates when its running work finishes.`
    case 'current': return `${machine} has no newer version yet.`
    case 'unsupported': return `Update Kybern on ${machine} itself.`
    case 'failed': return `Couldn’t update ${machine}. Try again, or update Kybern on it.`
    default: return `Updating Kybern on ${machine}…`
  }
}

/**
 * Whether a finished new sign-in becomes the default: only a machine's first usable account of the agent, and only while
 * no default is shared by every machine (setting one on this machine would change it everywhere).
 */
export const makesDefault = (accounts: readonly AccountSummary[], kind: ProviderKind, shared: AccountsShared | null | undefined): boolean =>
  !shared?.defaults?.[kind] && !accounts.some((a) => a.provider.kind === kind && a.status === 'signed_in')

/** The primary action of a failed borrow's card, whatever failed: this machine signs in itself. The daemon names it
 *  `sign_in_here` and words it; an error without it gets the same button. */
export function signInHereAction(error: unknown, view: Pick<ProblemView, 'action' | 'secondary'>, machine: string): { id: 'sign_in_here'; label: string } {
  const problem = problemOf(error)
  const named = [view.action, view.secondary, problem?.action, problem?.secondary].find((action) => action?.id === 'sign_in_here')
  return { id: 'sign_in_here', label: named?.label || `Sign in on ${machine} instead` }
}

// ── The queue ────────────────────────────────────────────────────────────────

export type ItemResult =
  /** Signed in, and saved. */
  | 'signed_in'
  /** That machine already had this account. */
  | 'already'
  | 'borrowed'
  | 'skipped'
  | 'failed'

export interface QueueState {
  items: readonly SignInItem[]
  index: number
  results: Readonly<Record<string, ItemResult>>
  /** The email, name and colour the first sign-in of an "Add account" settled on, kept for the machines after it. */
  email?: string
  name?: string
  color?: string
}

export const startQueue = (items: readonly SignInItem[]): QueueState => ({ items: items.map(keepOwnAntigravityLogin), index: 0, results: {} })
export const currentItem = (state: QueueState): SignInItem | null => state.items[state.index] ?? null
export const queueDone = (state: QueueState) => state.index >= state.items.length

export interface Settled {
  email?: string
  name?: string
  color?: string
}

/** The current machine is done; move to the next. */
export function advance(state: QueueState, result: ItemResult, settled: Settled = {}): QueueState {
  const item = currentItem(state)
  if (!item) return state
  const next: QueueState = { ...state, index: state.index + 1, results: { ...state.results, [item.id]: result } }
  // One account added to several machines keeps the first sign-in's email, name and colour.
  const sameAccount = isOneAccount(state.items)
  if (sameAccount) {
    next.email = state.email ?? settled.email
    next.name = state.name ?? settled.name
    next.color = state.color ?? settled.color
  }
  return next
}

/** Every item adds the same new account (not a list of different ones). */
export const isOneAccount = (items: readonly SignInItem[]) => items.every((item) => item.kind === items[0]?.kind && !item.instance && !item.email && item.name === items[0]?.name)

/** What the current machine should sign in: the item, filled with what earlier machines settled. */
export function resolvedItem(state: QueueState): SignInItem | null {
  const item = currentItem(state)
  if (!item) return null
  return {
    ...item,
    ...(item.email ? {} : state.email ? { email: state.email } : {}),
    ...(item.name ? {} : state.name ? { name: state.name } : {}),
    ...(item.color ? {} : state.color ? { color: state.color } : {}),
  }
}

/** The sign-in ended on a different account than the one wanted. */
export function mismatch(item: Pick<SignInItem, 'email'>, login: Pick<AccountLogin, 'identity'>): string | null {
  const got = login.identity?.email
  return item.email && got && got.toLowerCase() !== item.email.toLowerCase() ? got : null
}
