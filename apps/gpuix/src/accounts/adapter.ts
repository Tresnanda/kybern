// The daemon calls that a current daemon may not have yet, in one place. A daemon lists `accounts.shared.v1` when it
// stores and syncs `Settings.accounts_shared`, computes offers and may sign a terminal login in or out. Without it the
// page still works: names and "Only when I choose" are kept on this computer, the default is set on each machine, and
// offers are worked out here.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import type { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
import { ACCOUNTS_SHARED_FEATURE, LOGIN_HANDOFF_FEATURE, type AccountOffer, type AccountsShared, type LoginBrokerSetParams, type LoginBrokerStatus, type LoginHandoffParams, type MachineCard, type MachineId, type ProviderKind, type Settings } from '../../../../packages/kybern-client/src/types.ts'
import { errorMessage } from '../../../../packages/kybern-client/src/problem.ts'
import { configDir } from '../environments/registry.ts'
import { setSettings } from '../settings/store.ts'
import { lenderUsable } from './offers.ts'

export const supportsShared = (features: readonly string[] | undefined | null) => !!features?.includes(ACCOUNTS_SHARED_FEATURE)
export const featuresOf = (client: Pick<KybernClient, 'info'> | null | undefined): string[] => client?.info?.features ?? []

const isMethodNotFound = (error: unknown) => /method not found|-32601|unknown method/i.test(errorMessage(error))

/** `accounts.offers`, or null when the daemon cannot compute offers (they are then worked out here). */
export async function fetchDaemonOffers(client: KybernClient): Promise<AccountOffer[] | null> {
  if (!supportsShared(featuresOf(client))) return null
  // The daemon leaves `keys` and `machines` out when they are empty (terminal login, migration clash offers).
  try { return (await client.call('accounts.offers', {})).offers.map((offer) => ({ ...offer, keys: offer.keys ?? [], machines: offer.machines ?? [] })) } catch (error) {
    if (isMethodNotFound(error)) return null
    throw error
  }
}

/** Sign the agent's own terminal login out on that machine. Only a daemon with the feature does this, and only when asked. */
export const signOutTerminalLogin = (client: KybernClient, kind: ProviderKind) =>
  client.call('providers.accounts.sign_out', { kind, instance: 'default', confirm_terminal: true })

// ── Authorize only ───────────────────────────────────────────────────────────

/** Harnesses whose own CLI waits for a loopback redirect, which the computer's daemon can catch for another machine. */
const HANDOFF_KINDS: readonly ProviderKind[] = ['claude-code', 'codex']

/** One "Authorize" per machine: both this computer's daemon and the machine being signed in must know how. */
export const canHandoff = (kind: ProviderKind, computer: readonly string[] | null, target: readonly string[]) =>
  HANDOFF_KINDS.includes(kind) && !!computer?.includes(LOGIN_HANDOFF_FEATURE) && target.includes(LOGIN_HANDOFF_FEATURE)

/** Ask this computer's daemon to catch the redirect of a sign-in on another machine; returns the page to open here. */
export const handoffSignIn = (computer: KybernClient, params: LoginHandoffParams) => computer.call('providers.accounts.login.handoff', params)

// ── Sharing sign-ins ─────────────────────────────────────────────────────────

/** The machine whose sign-ins the others can use. */
export interface Sharing {
  machineId: MachineId
  machine: string
  /** A machine being set up may borrow from it. Existing borrowers keep borrowing either way. */
  usable: boolean
  /** The daemon's own sentence for why it isn't. */
  reason?: string
}

/** `lender.usable_for_new` and `lender.reason` of `login.broker.status` (0.27.2, `login.broker.choice.v1`). Older daemons
 *  send no `lender`. */
export function lenderVerdict(status: LoginBrokerStatus | null | undefined): { usableForNew?: boolean; reason?: string } {
  const lender = (status as { lender?: { usable_for_new?: unknown; reason?: unknown } | null } | null | undefined)?.lender
  if (typeof lender?.usable_for_new !== 'boolean') return {}
  return { usableForNew: lender.usable_for_new, ...(typeof lender.reason === 'string' && lender.reason ? { reason: lender.reason } : {}) }
}

/** A daemon that lends each agent from its own machine: `login.broker.status` carries `lenders_by_kind` and
 *  `login.broker.set` takes `provider` (0.27.3). */
export const LOGIN_BROKER_PER_KIND_FEATURE = 'login.broker.per_kind.v1'
export const supportsPerKind = (features: readonly string[] | undefined | null) => !!features?.includes(LOGIN_BROKER_PER_KIND_FEATURE)

/** Choose the sharing machine, or clear it with null. Neither signs the previous one out of its own accounts. `via` says
 *  the always-on offer chose it; without it the daemon records a choice by hand (0.27.2; older daemons ignore it).
 *  `provider` sets or clears the lender of that agent only (`login.broker.per_kind.v1`); without it, every agent's. */
export async function setSharing(client: KybernClient, machineId: MachineId | null, via?: 'always_on', provider?: ProviderKind) {
  const set = (machine: MachineId | null, kind?: ProviderKind) => {
    const params: LoginBrokerSetParams & { via?: 'always_on'; provider?: ProviderKind } = { machine_id: machine, sign_out_old: false, ...(via && machine ? { via } : {}), ...(kind ? { provider: kind } : {}) }
    return client.call('login.broker.set', params)
  }
  if (!provider || machineId) return set(machineId, provider)
  // One agent to "each machine signs in": the daemon reads a cleared agent as "follow the network-wide lender", so while
  // one exists, pin every other agent to its current lender, clear that default, then clear this agent's own.
  const status = await client.call('login.broker.status', {}) as { broker?: { machine_id?: string } | null; lenders_by_kind?: Partial<Record<ProviderKind, { machine_id?: string } | null>> }
  if (status.broker?.machine_id) {
    for (const kind of SHAREABLE_KINDS) {
      const lender = status.lenders_by_kind?.[kind]?.machine_id
      if (kind !== provider && lender) await set(lender, kind)
    }
    await set(null)
  }
  return set(null, provider)
}

/** The agents another machine can lend sign-ins for. */
export const SHAREABLE_KINDS: readonly ProviderKind[] = ['claude-code', 'codex', 'omp']

type Members = readonly Pick<MachineCard, 'machine_id' | 'name' | 'online_ratio_7d'>[]
interface KindLender { machine_id?: unknown; name?: unknown; usable_for_new?: unknown; reason?: unknown }

/** One agent's lender from `lenders_by_kind`, as a `Sharing`. */
function kindSharing(entry: KindLender | null | undefined, members: Members): Sharing | null {
  if (!entry || typeof entry.machine_id !== 'string' || !entry.machine_id) return null
  const member = members.find((m) => m.machine_id === entry.machine_id)
  const name = typeof entry.name === 'string' && entry.name ? entry.name : member?.name ?? 'your other machine'
  const said = typeof entry.usable_for_new === 'boolean' ? entry.usable_for_new : undefined
  return { machineId: entry.machine_id, machine: name, usable: lenderUsable(said, member?.online_ratio_7d), ...(typeof entry.reason === 'string' && entry.reason ? { reason: entry.reason } : {}) }
}

/** Each lendable agent's lender (`lenders_by_kind`, 0.27.3), null for a daemon that lends every agent from one machine.
 *  An agent missing from the map has no lender: each machine signs in itself. */
export function lendersByKind(status: LoginBrokerStatus | null | undefined, members: Members): Partial<Record<ProviderKind, Sharing | null>> | null {
  const map = (status as { lenders_by_kind?: unknown } | null | undefined)?.lenders_by_kind
  if (!map || typeof map !== 'object' || Array.isArray(map)) return null
  return Object.fromEntries(Object.entries(map as Record<string, KindLender>).map(([kind, entry]) => [kind, kindSharing(entry, members)])) as Partial<Record<ProviderKind, Sharing | null>>
}

/** The machines "Shared sign-ins" can pick (`lenders`, 0.27.2): each with why it can't, when it can't. */
export interface LenderOption { machineId: MachineId; name: string; canShare: boolean; reason?: string }
export function lenderOptions(status: LoginBrokerStatus | null | undefined): LenderOption[] | null {
  const lenders = status?.lenders
  if (!Array.isArray(lenders)) return null
  return lenders.filter((l) => l.supported || l.is_lender).map((l) => ({ machineId: l.machine_id, name: l.name, canShare: l.can_share || l.is_lender, ...(l.reason ? { reason: l.reason } : {}) }))
}

/** The sharing machine from `login.broker.status` and the members of `network.status`; null when nobody shares. */
export function sharingFrom(status: LoginBrokerStatus | null | undefined, members: Members): Sharing | null {
  const lender = status?.broker
  if (!lender) return null
  const member = members.find((m) => m.machine_id === lender.machine_id)
  const verdict = lenderVerdict(status)
  return {
    machineId: lender.machine_id,
    machine: lender.name ?? member?.name ?? 'your other machine',
    usable: lenderUsable(verdict.usableForNew, member?.online_ratio_7d),
    ...(verdict.reason ? { reason: verdict.reason } : {}),
  }
}

// ── Shared preferences ───────────────────────────────────────────────────────

const localFile = () => path.join(configDir(), 'accounts-shared.json')
let local: AccountsShared | undefined

/** This computer's copy, for a daemon that cannot store the shared preferences. */
export function localPrefs(): AccountsShared {
  if (local) return local
  try {
    const value = JSON.parse(readFileSync(localFile(), 'utf8')) as unknown
    local = value && typeof value === 'object' && !Array.isArray(value) ? value as AccountsShared : {}
  } catch { local = {} }
  return local
}
function writeLocal(next: AccountsShared) {
  local = next
  try { mkdirSync(configDir(), { recursive: true }); writeFileSync(localFile(), `${JSON.stringify(next, null, 2)}\n`) } catch { /* kept for this run */ }
}

/** The shared preferences as they stand: the daemon's, else this computer's. */
export const readShared = (settings: Pick<Settings, 'accounts_shared'> | null | undefined, features: readonly string[]): AccountsShared =>
  supportsShared(features) ? settings?.accounts_shared ?? {} : localPrefs()

let writes: Promise<unknown> = Promise.resolve()
/**
 * Change the shared preferences. Writes run one after another against a fresh read of the daemon's settings, so two quick
 * changes both land. A daemon with the feature syncs them to every machine and answers with the saved settings; for an
 * older one the change is kept on this computer and the answer is null.
 */
export function writeShared(client: KybernClient, change: (current: AccountsShared) => AccountsShared): Promise<Settings | null> {
  if (!supportsShared(featuresOf(client))) {
    writeLocal(change(localPrefs()))
    return Promise.resolve(null)
  }
  const run = writes.then(async () => {
    const settings = await client.call('settings.get', {})
    // `base`: only the shared preferences this change touched are saved, whatever else arrived meanwhile.
    const saved = await client.call('settings.update', { settings: { ...settings, accounts_shared: change(settings.accounts_shared ?? {}) }, base: settings })
    setSettings(saved)
    return saved
  })
  writes = run.catch(() => {})
  return run
}
