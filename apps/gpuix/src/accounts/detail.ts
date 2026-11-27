// What Settings › Accounts says about one account: one line in the list, and one status per machine in its detail pane.
// Each machine says one plain thing ("Signed in", "From fedora", "Signed out", "Not signed in", "Offline"…) and the page
// offers at most one action for it; the agent's own terminal login is folded into "Signed in" and never named. Pure:
// tests load it directly.
import { withoutSignIn } from '../shared/lib/accounts.ts'
import { isOutdatedMachine, standings, type HarnessGroup, type MachineAccounts, type MachineStanding, type UnifiedAccount } from './unified.ts'

export type MachineState =
  | 'signed_in'
  /** Uses another machine's sign-in (`lender`). */
  | 'borrowed'
  /** Borrows from a machine that can't be reached now (`lender`). */
  | 'unreachable'
  /** Has the account but runs new threads on another (`uses`): it doesn't follow the shared default. */
  | 'uses'
  | 'signed_out'
  /** Could have the account and has no login for it. */
  | 'not_signed_in'
  | 'checking'
  | 'offline'
  | 'not_installed'
  /** Its Kybern is too old to list accounts. */
  | 'outdated'

export interface MachineRow {
  machineId: string
  machine: string
  isLocal: boolean
  state: MachineState
  lender?: string
  uses?: string
  standing?: MachineStanding
}

const installed = (machine: MachineAccounts, kind: UnifiedAccount['kind']) => machine.providers?.find((p) => p.kind === kind)?.available !== false

/** The account can be signed in on a machine that doesn't have it: it has an identity and the agent a sign-in. */
export const addable = (account: Pick<UnifiedAccount, 'key' | 'kind'>) => !!account.key && !withoutSignIn(account.kind)

/** One row per machine that has the account or could; this machine first. */
export function machineRows(account: UnifiedAccount, machines: readonly MachineAccounts[]): MachineRow[] {
  const there = new Map(standings(account).map((standing) => [standing.machineId, standing]))
  const canAdd = addable(account)
  const rows: MachineRow[] = []
  for (const machine of machines) {
    const standing = there.get(machine.machineId)
    const base = { machineId: machine.machineId, machine: machine.name, isLocal: machine.isLocal, ...(standing ? { standing } : {}) }
    if (!standing && !canAdd) continue
    if (!machine.online) { rows.push({ ...base, state: 'offline' }); continue }
    if (isOutdatedMachine(machine)) { rows.push({ ...base, state: 'outdated' }); continue }
    const unfollowed = account.unfollowed?.find((u) => u.machineId === machine.machineId)
    if (standing) {
      if (unfollowed?.hasAccount) { rows.push({ ...base, state: 'uses', uses: unfollowed.uses }); continue }
      switch (standing.state) {
        case 'borrowed': rows.push({ ...base, state: 'borrowed', lender: standing.lender ?? 'another machine' }); break
        case 'borrow_unreachable': rows.push({ ...base, state: 'unreachable', lender: standing.lender ?? 'another machine' }); break
        case 'signed_in': rows.push({ ...base, state: 'signed_in' }); break
        // A terminal login that doesn't say whether it works is the shell's own: it runs.
        case 'unknown': rows.push({ ...base, state: standing.terminal || standing.presences.some((p) => p.terminal) ? 'signed_in' : 'checking' }); break
        case 'signed_out': rows.push({ ...base, state: 'signed_out' }); break
      }
      continue
    }
    if (machine.state === 'reading') rows.push({ ...base, state: 'checking' })
    else if (machine.state !== 'ready') rows.push({ ...base, state: 'offline' })
    else if (!installed(machine, account.kind)) rows.push({ ...base, state: 'not_installed' })
    else rows.push({ ...base, state: 'not_signed_in' })
  }
  return rows
}

/** An agent with no account at all, only signed-out logins of its own: where it can be signed in. */
export function agentRows(group: HarnessGroup, machines: readonly MachineAccounts[]): MachineRow[] {
  const rows: MachineRow[] = []
  for (const machine of machines) {
    const base = { machineId: machine.machineId, machine: machine.name, isLocal: machine.isLocal }
    const entry = group.signedOutTerminals.find((e) => e.machineId === machine.machineId)
    if (!machine.online) { if (entry) rows.push({ ...base, state: 'offline' }); continue }
    if (isOutdatedMachine(machine)) { rows.push({ ...base, state: 'outdated' }); continue }
    if (entry) rows.push({ ...base, state: 'not_signed_in' })
    else if (machine.providers?.find((p) => p.kind === group.kind)?.available === false) rows.push({ ...base, state: 'not_installed' })
  }
  return rows
}

/** The words of each state; `lender` and `uses` fill in the machine or account. */
export function stateLabel(row: Pick<MachineRow, 'state' | 'lender' | 'uses'>): string {
  switch (row.state) {
    case 'signed_in': return 'Signed in'
    case 'borrowed': return `From ${row.lender}`
    case 'unreachable': return `Can’t reach ${row.lender}`
    case 'uses': return `Uses ${row.uses}`
    case 'signed_out': return 'Signed out'
    case 'not_signed_in': return 'Not signed in'
    case 'checking': return 'Checking…'
    case 'offline': return 'Offline'
    case 'not_installed': return 'Not installed'
    case 'outdated': return 'Needs a newer Kybern'
  }
}

/** `ok` green, `warn` amber, `quiet` no dot and tertiary text. */
export const stateTone = (state: MachineState): 'ok' | 'warn' | 'neutral' | 'quiet' =>
  state === 'signed_in' || state === 'borrowed' ? 'ok'
    : state === 'signed_out' || state === 'unreachable' ? 'warn'
      : state === 'uses' ? 'neutral'
        : 'quiet'

const USABLE: readonly MachineState[] = ['signed_in', 'borrowed', 'uses']
const list = (names: readonly string[]) => new Intl.ListFormat('en', { style: 'long', type: 'conjunction' }).format(names)

/** The list row's second line: where the account works, or the one thing that needs attention. */
export function accountSummary(account: Pick<UnifiedAccount, 'email' | 'name' | 'plan'>, rows: readonly MachineRow[], machineCount: number): { text: string; warn: boolean } {
  const out = rows.filter((row) => row.state === 'signed_out').map((row) => row.machine)
  if (machineCount < 2) {
    if (out.length) return { text: 'Signed out', warn: true }
    return { text: [account.email && account.email !== account.name ? account.email : null, account.plan].filter(Boolean).join(' · '), warn: false }
  }
  if (out.length) return { text: `Signed out on ${list(out)}`, warn: true }
  const lost = rows.find((row) => row.state === 'unreachable')
  if (lost) return { text: `Can’t reach ${lost.lender}`, warn: true }
  const usable = rows.filter((row) => USABLE.includes(row.state)).map((row) => row.machine)
  if (!usable.length) return { text: 'Not signed in', warn: false }
  if (usable.length === machineCount) return { text: 'All machines', warn: false }
  return { text: usable.length > 2 ? `${usable.length} machines` : usable.join(' · '), warn: false }
}
