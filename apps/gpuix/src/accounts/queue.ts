// One sign-in per machine, one after another: what "Add account", "Set up" and a machine's chip all start. Each machine
// gets its own login (a copied login breaks both), or borrows a shared one where that is possible. Pure: planning and the
// queue's state; `dialogs/Account.tsx` runs the steps.
import { initialLoginMode } from '../shared/lib/accounts.ts'
import type { AccountLogin, AccountLoginMode, AccountSummary, LendableAccount, MachineId, ProviderKind } from '../../../../packages/kybern-client/src/types.ts'
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
  if (item.kind === 'antigravity') return item.instance === 'default' ? 'terminal' : 'paste'
  if (remote && handoff) return 'browser'
  return initialLoginMode(item.kind, remote)
}

/** The code to fall back to when a handoff can't be done: Codex's device code, else a pasted code. */
export const fallbackModeFor = (kind: ProviderKind): AccountLoginMode => initialLoginMode(kind, true)

const antigravityOwnSignedIn = (accounts: readonly AccountSummary[]) =>
  accounts.some((a) => a.provider.kind === 'antigravity' && a.provider.instance === 'default' && (a.status === 'signed_in' || (a.status === 'unknown' && !!a.identity)))

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
export function planAdd({ kind, name, machines, computer, directory }: AddRequest): SignInItem[] {
  const label = name?.trim() || undefined
  return machines.map((machine) => {
    const item: SignInItem = { id: `${machine.machineId}:${kind}:new`, machineId: machine.machineId, machine: machine.name, kind, method: 'sign_in', ...(label ? { name: label } : {}) }
    if (kind === 'antigravity') {
      // The first Antigravity sign-in on this computer is its own `agy` login; every one after it is a named account.
      if (machine.machineId === computer && !antigravityOwnSignedIn(machine.accounts)) item.ownLogin = true
      else item.named = true
    }
    if (directory && machines.length === 1) item.directory = directory
    return item
  })
}

/** Sign `account` in on one machine: its signed-out login there, else a new one. */
export function planOnMachine(account: UnifiedAccount, machine: Pick<MachineAccounts, 'machineId' | 'name'>): SignInItem {
  const standing = standings(account).find((s) => s.machineId === machine.machineId)
  const named = standing?.presences.find((p) => !p.terminal)
  const existing = named ?? standing?.presences[0]
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

/** The shared sign-in that can stand in for `account` on another machine, if the sharing machine has it. */
export function lenderFor(account: Pick<UnifiedAccount, 'kind' | 'email' | 'presences'>, sharing: { machineId: MachineId; machine: string; lendable: readonly LendableAccount[] } | null, target: MachineId): SignInItem['lender'] | undefined {
  if (!sharing || sharing.machineId === target || !LENDABLE_KINDS.includes(account.kind) || !account.email) return
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

export const startQueue = (items: readonly SignInItem[]): QueueState => ({ items, index: 0, results: {} })
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
