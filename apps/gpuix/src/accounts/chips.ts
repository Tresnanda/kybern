// The machine chips of an account row: where it is signed in, which shell uses it, what it borrows, and where it can be
// added. They answer "which account is fedora using, and does it touch my shell?" at a glance. Pure.
import { withoutSignIn } from '../shared/lib/accounts.ts'
import { standings, type MachineAccounts, type MachineStanding, type UnifiedAccount } from './unified.ts'

export type ChipState = 'signed_in' | 'borrowed' | 'unreachable' | 'signed_out' | 'unknown' | 'offline' | 'add'

export interface AccountChip {
  machineId: string
  machine: string
  state: ChipState
  /** The machine's shell uses this account. */
  terminal: boolean
  label: string
  standing?: MachineStanding
}

const stateOf = (standing: MachineStanding): ChipState => {
  if (!standing.online) return 'offline'
  if (standing.state === 'borrow_unreachable') return 'unreachable'
  return standing.state
}

/** Whether a machine can take this account: online, able to list accounts, and with the agent installed. */
const canAdd = (account: UnifiedAccount, machine: MachineAccounts) =>
  machine.online && machine.state === 'ready' && machine.providers?.find((p) => p.kind === account.kind)?.available !== false

const words: Record<ChipState, (standing: MachineStanding | undefined) => string> = {
  signed_in: (s) => (s?.terminal ? 'Terminal login' : 'Signed in'),
  borrowed: (s) => `From ${s?.lender}`,
  unreachable: (s) => `${s?.lender} unreachable`,
  signed_out: () => 'Signed out',
  unknown: (s) => (s?.terminal ? 'Terminal login' : 'Checking…'),
  offline: () => 'Offline',
  add: () => 'Add',
}

/** With several machines, each chip leads with the machine; the words after it say only what isn't plain "signed in". */
function label(machine: string, state: ChipState, standing: MachineStanding | undefined, several: boolean): string {
  if (!several) return words[state](standing)
  if (state === 'add') return machine
  if (state === 'signed_in' || state === 'unknown') return standing?.terminal ? `${machine} · Terminal login` : machine
  const rest = words[state](standing)
  return `${machine} · ${state === 'borrowed' ? rest.replace(/^From/, 'from') : rest}`
}

export function chipsFor(account: UnifiedAccount, machines: readonly MachineAccounts[]): AccountChip[] {
  const several = machines.length > 1
  const there = new Map(standings(account).map((standing) => [standing.machineId, standing]))
  const addable = !!account.key && !withoutSignIn(account.kind)
  const chips: AccountChip[] = []
  for (const machine of machines) {
    const standing = there.get(machine.machineId)
    if (!standing) {
      if (several && addable && canAdd(account, machine)) chips.push({ machineId: machine.machineId, machine: machine.name, state: 'add', terminal: false, label: label(machine.name, 'add', undefined, several) })
      continue
    }
    const state = stateOf(standing)
    // On a lone machine a plain sign-in needs no chip: the row itself says it.
    if (!several && state === 'signed_in' && !standing.terminal) continue
    chips.push({ machineId: machine.machineId, machine: machine.name, state, terminal: standing.terminal, label: label(machine.name, state, standing, several), standing })
  }
  return chips
}

/** "MacBook Pro · fedora": the machines an account can be used on, for the usage card's second line. */
export function usableMachines(account: UnifiedAccount): string[] {
  return standings(account).filter((s) => s.state === 'signed_in' || s.state === 'borrowed' || s.state === 'unknown').map((s) => s.machine)
}
