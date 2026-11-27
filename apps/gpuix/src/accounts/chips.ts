// The machine chips of an account row: where it is signed in, which shell uses it, what it borrows, and where it can be
// added. They answer "which account is fedora using, and does it touch my shell?" at a glance. Pure.
import { withoutSignIn } from '../shared/lib/accounts.ts'
import { LENDABLE_KINDS, LOGIN_SHARING_FEATURE } from './offers.ts'
import { isOutdatedMachine, standings, type MachineAccounts, type MachineStanding, type UnifiedAccount } from './unified.ts'

/** `terminal_out`: the account works on that machine, but its shell's own login of it is signed out. */
export type ChipState = 'signed_in' | 'borrowed' | 'unreachable' | 'signed_out' | 'terminal_out' | 'unknown' | 'offline' | 'add'

export interface AccountChip {
  machineId: string
  machine: string
  state: ChipState
  /** The machine's shell uses this account. */
  terminal: boolean
  label: string
  standing?: MachineStanding
  /** The other machines can use this sign-in: the machine is the one that shares. */
  lender?: boolean
}

/** What a machine's menu offers about its sign-ins: share them, stop sharing them, or nothing (a lone, offline or older
 *  machine, or a window whose own daemon can't choose). `machines` starts with this window's. */
export function sharingAction(machine: Pick<MachineAccounts, 'machineId' | 'online' | 'features'>, machines: readonly Pick<MachineAccounts, 'features'>[], sharing: string | null | undefined): 'share' | 'stop' | null {
  const able = (m: Pick<MachineAccounts, 'features'> | undefined) => !!m?.features.includes(LOGIN_SHARING_FEATURE)
  if (machines.length < 2 || !machine.online || !able(machine) || !able(machines[0])) return null
  return machine.machineId === sharing ? 'stop' : 'share'
}

const stateOf = (standing: MachineStanding): ChipState => {
  if (!standing.online) return 'offline'
  if (standing.state !== 'signed_out' && standing.presences.some((p) => p.terminal && p.state === 'signed_out')) return 'terminal_out'
  if (standing.state === 'borrow_unreachable') return 'unreachable'
  return standing.state
}

/** Whether a machine can take this account: online, able to list accounts, and with the agent installed. */
const canAdd = (account: UnifiedAccount, machine: MachineAccounts) =>
  machine.online && machine.state === 'ready' && !isOutdatedMachine(machine) && machine.providers?.find((p) => p.kind === account.kind)?.available !== false

const words: Record<ChipState, (standing: MachineStanding | undefined) => string> = {
  signed_in: (s) => (s?.terminal ? 'Terminal login' : 'Signed in'),
  borrowed: (s) => `From ${s?.lender}`,
  unreachable: (s) => `${s?.lender} unreachable`,
  signed_out: () => 'Signed out',
  terminal_out: () => 'Terminal signed out',
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

export function chipsFor(account: UnifiedAccount, machines: readonly MachineAccounts[], sharing?: string | null): AccountChip[] {
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
    const lender = several && machine.machineId === sharing && standing.state === 'signed_in' && LENDABLE_KINDS.includes(account.kind)
    chips.push({ machineId: machine.machineId, machine: machine.name, state, terminal: standing.terminal, label: label(machine.name, state, standing, several), standing, ...(lender ? { lender } : {}) })
  }
  return chips
}

/** "MacBook Pro · fedora": the machines an account can be used on, for the usage card's second line. */
export function usableMachines(account: UnifiedAccount): string[] {
  return standings(account).filter((s) => s.state === 'signed_in' || s.state === 'borrowed' || s.state === 'unknown').map((s) => s.machine)
}
