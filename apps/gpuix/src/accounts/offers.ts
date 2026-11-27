// Offers, not settings: cards the app shows on opening, each once per situation. A daemon with `accounts.shared.v1`
// computes them (`accounts.offers`); against older daemons the same candidates are worked out here from what each machine
// reported. Either way the answers ("Not now", "Never") live in `accounts_shared.offers`. Pure: tests load it directly.
import { PROVIDER_NAMES } from '../shared/lib/providerUsage.ts'
import { ACCOUNTS_SHARED_FEATURE, type AccountOffer, type AccountOfferState, type MachineId, type ProviderKind } from '../../../../packages/kybern-client/src/types.ts'
import { isUsable, standings, type HarnessGroup, type MachineAccounts, type UnifiedAccount } from './unified.ts'

export type Offer = AccountOffer

/** Agents with an identity a new machine can be set up with. */
export const OFFER_KINDS: readonly ProviderKind[] = ['claude-code', 'codex', 'cursor', 'antigravity']
/** Agents whose sign-in another machine can lend. */
export const LENDABLE_KINDS: readonly ProviderKind[] = ['claude-code', 'codex', 'omp']
/** Agents whose signed-out terminal login Kybern may sign in (Antigravity already could). */
export const TERMINAL_SIGN_IN_KINDS: readonly ProviderKind[] = ['claude-code', 'codex', 'cursor', 'antigravity']
/** Reachable at least this share of the last week counts as always on. */
export const ALWAYS_ON_RATIO = 0.9
export const LOGIN_SHARING_FEATURE = 'login.broker.v1'

/** Whether a machine being set up may borrow from the sharing machine: the daemon's word, else only an always-on one. */
export const lenderUsable = (said: boolean | undefined, onlineRatio: number | null | undefined): boolean =>
  said ?? (onlineRatio ?? 0) >= ALWAYS_ON_RATIO

const installed = (machine: MachineAccounts, kind: ProviderKind) => {
  const status = machine.providers?.find((provider) => provider.kind === kind)
  // Unknown is not installed: an offer must not ask someone to sign in to an agent a machine may not have.
  return status?.available === true
}

const has = (account: UnifiedAccount, machine: MachineId) => account.presences.some((p) => p.machineId === machine)
const usableOn = (account: UnifiedAccount, machine: MachineId) => standings(account).some((s) => s.machineId === machine && isUsable(s.state))
/** Signed in with its own login (not borrowed) somewhere. */
const ownedBy = (account: UnifiedAccount, machine: MachineId) => account.presences.some((p) => p.machineId === machine && p.state === 'signed_in')

export interface OfferContext {
  groups: readonly HarnessGroup[]
  machines: readonly MachineAccounts[]
  /** `MachineCard.online_ratio_7d` by machine. */
  ratios: Readonly<Record<MachineId, number | null | undefined>>
  /** The machine whose sign-ins the others already use. */
  sharing: MachineId | null
}

const ready = (machine: MachineAccounts) => machine.online && machine.state === 'ready'
const identityAccounts = (groups: readonly HarnessGroup[]) => groups.flatMap((group) => group.accounts.filter((account) => account.key && OFFER_KINDS.includes(account.kind)))
const sorted = (values: Iterable<string>) => [...values].sort()

/** The offers of a network whose daemon cannot compute them. A migration clash needs the daemon's record, so none here. */
export function computeOffers({ groups, machines, ratios, sharing }: OfferContext): Offer[] {
  const offers: Offer[] = []
  const online = machines.filter(ready)
  if (!online.length) return offers

  // New machine: accounts signed in elsewhere that this machine doesn't have.
  for (const machine of online) {
    const missing = identityAccounts(groups).filter((account) => !has(account, machine.machineId)
      && installed(machine, account.kind)
      && online.some((other) => other.machineId !== machine.machineId && usableOn(account, other.machineId)))
    if (!missing.length) continue
    const keys = sorted(missing.map((account) => account.key!))
    const sources = sorted(new Set(missing.flatMap((account) => standings(account).filter((s) => isUsable(s.state)).map((s) => s.machineId))))
    offers.push({ id: `new_machine:${machine.machineId}`, kind: 'new_machine', fingerprint: keys.join(','), machine_id: machine.machineId, machine_name: machine.name, keys, machines: sources })
  }

  // Always on: letting the others use this machine's sign-ins would save sign-ins.
  if (!sharing) {
    for (const machine of online) {
      if ((ratios[machine.machineId] ?? 0) < ALWAYS_ON_RATIO || !machine.features.includes(LOGIN_SHARING_FEATURE)) continue
      const savings = identityAccounts(groups)
        .filter((account) => LENDABLE_KINDS.includes(account.kind) && ownedBy(account, machine.machineId))
        .map((account) => ({ account, lacking: online.filter((other) => other.machineId !== machine.machineId && installed(other, account.kind) && !usableOn(account, other.machineId)) }))
        .filter((saving) => saving.lacking.length > 0)
      if (!savings.length) continue
      const keys = sorted(savings.map((saving) => saving.account.key!))
      const lacking = sorted(new Set(savings.flatMap((saving) => saving.lacking.map((other) => other.machineId))))
      offers.push({ id: `always_on:${machine.machineId}`, kind: 'always_on', fingerprint: `${keys.join(',')}|${lacking.join(',')}`, machine_id: machine.machineId, machine_name: machine.name, keys, machines: lacking })
    }
  }

  // Empty terminal login: only where the daemon can sign it in, and only for an agent the user signs in to somewhere.
  for (const machine of online) {
    if (!machine.features.includes(ACCOUNTS_SHARED_FEATURE)) continue
    for (const group of groups) {
      if (!TERMINAL_SIGN_IN_KINDS.includes(group.kind) || !installed(machine, group.kind)) continue
      const empty = group.signedOutTerminals.some((entry) => entry.machineId === machine.machineId)
        || group.accounts.some((account) => account.presences.some((p) => p.machineId === machine.machineId && p.terminal && p.state === 'signed_out'))
      const used = group.accounts.some((account) => account.key && account.presences.some((p) => isUsable(p.state)))
      if (!empty || !used) continue
      offers.push({ id: `terminal_login:${machine.machineId}:${group.kind}`, kind: 'terminal_login', fingerprint: 'signed_out', machine_id: machine.machineId, machine_name: machine.name, provider: group.kind, keys: [], machines: [] })
    }
  }
  return offers
}

/** Mark each offer with the answer already given. A "Not now" counts only while the situation is the one it answered. */
export function applyAnswers(offers: readonly Offer[], answers: Readonly<Record<string, AccountOfferState>> | undefined): Offer[] {
  return offers.map((offer) => {
    const answer = answers?.[offer.id]
    const dismissed = answer && (answer.state === 'never' || answer.fingerprint === offer.fingerprint) ? answer.state : null
    const { dismissed: _, ...rest } = offer
    return dismissed ? { ...rest, dismissed } : rest
  })
}

/** Which card comes first: a changed default, then setting a machine up, then saving future sign-ins. */
const PRIORITY: Record<Offer['kind'], number> = { migration_clash: 0, new_machine: 1, always_on: 2, terminal_login: 3 }

export const sortOffers = (offers: readonly Offer[]): Offer[] => [...offers].sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || a.machine_name.localeCompare(b.machine_name) || a.id.localeCompare(b.id))

/** The one card to show on opening, or null. `handled` holds cards closed or acted on this run. */
export function nextCard(offers: readonly Offer[], handled: ReadonlySet<string> = new Set()): Offer | null {
  return sortOffers(offers).find((offer) => !offer.dismissed && !handled.has(`${offer.id}:${offer.fingerprint}`)) ?? null
}

/** What the Accounts page lists: every offer still true, answered "Not now" too. "Never" is gone for good. */
export const listedOffers = (offers: readonly Offer[]): Offer[] => sortOffers(offers.filter((offer) => offer.dismissed !== 'never'))

export interface OfferCopy {
  title: string
  body?: string
  /** The accept button. */
  action: string
  /** A clash's other answer ("Change"). */
  alternative?: string
}

const agent = (kind: ProviderKind | null | undefined) => (kind ? PROVIDER_NAMES[kind] ?? kind : 'the agent')

export function offerCopy(offer: Offer, nameOf: (key: string) => string): OfferCopy {
  const machine = offer.machine_name
  switch (offer.kind) {
    case 'new_machine':
      return { title: `Use your accounts on ${machine}?`, action: 'Set up' }
    case 'always_on':
      return { title: `Share ${machine}’s sign-ins?`, body: 'Your other machines use them without signing in again.', action: 'Share sign-ins' }
    case 'terminal_login':
      return { title: `Sign in ${agent(offer.provider)} in ${machine}’s terminal?`, action: 'Sign in' }
    case 'migration_clash': {
      const was = offer.clash ? nameOf(offer.clash.was) : ''
      const now = offer.clash ? nameOf(offer.clash.now) : ''
      return { title: `${machine}’s default was ${was}, now ${now} everywhere`, action: 'Keep', alternative: 'Change' }
    }
  }
}
