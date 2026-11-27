// Every account of every machine, as one list: the unified view of "Accounts across machines". Each daemon keeps its own
// logins; this layer asks every machine for its accounts and groups them by identity (`<kind>:<email>`), so an account
// signed in on two machines is one row, read once. No React and no GPUIX: tests load it directly.
import { CLI_ACCOUNT_NAME, CLI_INSTANCE, isCliInstance, withoutSignIn } from '../shared/lib/accounts.ts'
import { bindingLimit, limitUsed } from '../shared/lib/providerUsage.ts'
import { ACCOUNTS_SHARED_FEATURE, type AccountSummary, type AccountsShared, type ProviderInstance, type ProviderKind, type ProviderLimits, type ProviderStatus, type UnfollowedDefault } from '../../../../packages/kybern-client/src/types.ts'

/** What one machine told us about its accounts. */
export interface MachineAccounts {
  machineId: string
  name: string
  /** The machine this window is connected to. */
  isLocal: boolean
  online: boolean
  /** `reading`: no answer yet. `legacy`: too old to list accounts. `unreachable`: the last read failed (rows read before stay). */
  state: 'reading' | 'ready' | 'legacy' | 'unreachable'
  accounts: readonly AccountSummary[]
  /** `providers.list`; null while unknown, when every listed agent counts as installed. */
  providers: readonly ProviderStatus[] | null
  /** Per-account limits (`instance` set). */
  limits: readonly ProviderLimits[]
  /** The machine's own entry per agent: its default account's limits. */
  globalLimits: readonly ProviderLimits[]
  features: readonly string[]
  /** What this connection may do there (`daemon.info.scopes`). */
  scopes?: readonly string[]
  /** The shared defaults it doesn't run new threads on (`unfollowed_defaults`); older daemons report none. */
  unfollowed?: readonly UnfollowedDefault[]
}

/** Where one account stands on one login of one machine. */
export type PresenceState = 'signed_in' | 'borrowed' | 'borrow_unreachable' | 'signed_out' | 'unknown'

export interface AccountPresence {
  machineId: string
  machine: string
  instance: string
  /** The agent's own login in that machine's shell (instance `default`). */
  terminal: boolean
  state: PresenceState
  online: boolean
  /** The machine whose sign-in this one borrows. */
  lender?: string
  managed: boolean
  canSignOut: boolean
  /** The machine's own default for the agent. */
  defaultThere: boolean
  directory?: string
  projects: readonly string[]
}

export interface LimitReading {
  entry: ProviderLimits
  machineId: string
}

export interface UnifiedAccount {
  /** Stable within a read: the identity key, or a machine-only id. */
  id: string
  /** `<kind>:<email>`; null for logins without an identity. */
  key: string | null
  kind: ProviderKind
  /** The row stands for terminal logins that report no account (usually signed out). */
  terminalOnly: boolean
  email?: string
  plan?: string
  name: string
  color?: string
  /** "Only when I choose": never picked for you. */
  manualOnly: boolean
  isDefault: boolean
  presences: AccountPresence[]
  /** The freshest limit reading of this account from any machine; the same account on two machines counts once. */
  limit: LimitReading | null
  /** Set on the shared default: the online machines that run new threads on another account instead. */
  unfollowed?: Unfollowed[]
}

/** A machine that can't, or chose not to, run the default every machine shares. */
export interface Unfollowed {
  machineId: string
  /** The name of the account it uses instead. */
  uses: string
  /** It has a login for the default; `false` means signing in there is what it needs. */
  hasAccount: boolean
}

/** A shell's own login that is signed out and reports no account: one line under the agent, not a row. */
export interface SignedOutTerminal {
  machineId: string
  machine: string
  online: boolean
  /** It is the machine's own default for the agent. */
  defaultThere: boolean
}

export interface HarnessGroup {
  kind: ProviderKind
  accounts: UnifiedAccount[]
  signedOutTerminals: SignedOutTerminal[]
}

/** The name of a row that stands for the shells' own logins that work but report no account. */
export const TERMINAL_ROW_NAME = 'Terminal login'

export const accountKey = (kind: ProviderKind, email: string | null | undefined): string | null => {
  const normal = email?.trim().toLowerCase()
  return normal ? `${kind}:${normal}` : null
}

/** The key the daemon gave, else the one its identity implies. */
export const keyOf = (account: Pick<AccountSummary, 'key' | 'identity' | 'provider'>): string | null =>
  account.key || accountKey(account.provider.kind, account.identity?.email)

export const presenceState = (account: Pick<AccountSummary, 'broker' | 'status' | 'identity'>): PresenceState => {
  const broker = account.broker
  if (broker) {
    if (broker.state === 'borrowing') return 'borrowed'
    if (broker.state === 'broker_offline') return 'borrow_unreachable'
    if (broker.state === 'lending') return 'signed_in'
    return 'signed_out'
  }
  if (account.status === 'signed_in') return 'signed_in'
  if (account.status === 'signed_out' || account.status === 'needs_sign_in') return 'signed_out'
  return account.identity ? 'signed_in' : 'unknown'
}

/** Whether an agent on this login can be used now. */
export const isUsable = (state: PresenceState) => state === 'signed_in' || state === 'borrowed'

const installedOn = (machine: MachineAccounts, kind: ProviderKind) => {
  const status = machine.providers?.find((provider) => provider.kind === kind)
  return status ? status.available : true
}

/** This machine first, then the others in the order given. */
const ordered = (machines: readonly MachineAccounts[]) => [...machines.filter((m) => m.isLocal), ...machines.filter((m) => !m.isLocal)]

/** Whether a machine's daemon is too old to send account keys (must update Kybern rather than show anonymous logins). */
export function isOutdatedMachine(machine: Pick<MachineAccounts, 'online' | 'state' | 'features' | 'accounts'>): boolean {
  if (machine.state === 'legacy') return true
  if (!machine.online || machine.state !== 'ready') return false
  if (machine.features.length > 0 && !machine.features.includes(ACCOUNTS_SHARED_FEATURE)) {
    return machine.accounts.length > 0 && !machine.accounts.some((account) => !!keyOf(account))
  }
  return false
}

/** Online machines whose daemon is too old to send account keys, this machine first. */
export function outdatedMachines(machines: readonly MachineAccounts[]): MachineAccounts[] {
  return ordered(machines).filter((machine) => machine.online && isOutdatedMachine(machine))
}

/** Row label for a machine whose daemon is too old to send account keys. */
export const outdatedMachineLabel = (name: string) => `${name} · Update Kybern`

interface Draft {
  id: string
  key: string | null
  kind: ProviderKind
  terminalOnly: boolean
  summaries: { machine: MachineAccounts; account: AccountSummary; presence: AccountPresence }[]
}

/** Newer readings win; a machine this window is on wins a tie. Entries with no limits never beat entries with some. */
function fresher(a: LimitReading, b: LimitReading, local: string | undefined): LimitReading {
  const has = (r: LimitReading) => (r.entry.limits.length > 0 ? 1 : 0)
  if (has(a) !== has(b)) return has(a) > has(b) ? a : b
  const time = (r: LimitReading) => Date.parse(r.entry.updated_at ?? '') || 0
  if (time(a) !== time(b)) return time(a) > time(b) ? a : b
  return b.machineId === local ? b : a
}

/** The limits one machine reports for one of its logins. */
export function limitsOn(machine: MachineAccounts, account: Pick<AccountSummary, 'provider' | 'is_default'>): ProviderLimits | undefined {
  const { kind, instance } = account.provider
  return machine.limits.find((entry) => entry.provider === kind && entry.instance === instance)
    ?? (account.is_default ? machine.globalLimits.find((entry) => entry.provider === kind && !entry.instance) : undefined)
}

export interface UnifyOptions {
  shared?: AccountsShared | null
}

/** Merge what every machine reported into one list per agent. */
export function unifyAccounts(machines: readonly MachineAccounts[], options: UnifyOptions = {}): HarnessGroup[] {
  const shared = options.shared ?? {}
  const drafts = new Map<string, Draft>()
  const kinds: ProviderKind[] = []
  const signedOut: (SignedOutTerminal & { kind: ProviderKind })[] = []
  const local = machines.find((machine) => machine.isLocal)?.machineId
  for (const machine of ordered(machines)) {
    if (isOutdatedMachine(machine)) continue
    for (const account of machine.accounts) {
      const { kind, instance } = account.provider
      const terminal = account.terminal ?? isCliInstance(instance)
      // omp, OpenCode and pi have no sign-in: only profiles the user set up are listed.
      if (withoutSignIn(kind) && terminal) continue
      // An agent that isn't installed there has no terminal login worth showing.
      if (terminal && !installedOn(machine, kind)) continue
      const key = withoutSignIn(kind) ? null : keyOf(account)
      const id = key ?? (terminal ? `${kind}:@terminal` : `${kind}:@${machine.machineId}:${instance}`)
      const state = presenceState(account)
      if (terminal && !key && state === 'signed_out') {
        signedOut.push({ kind, machineId: machine.machineId, machine: machine.name, online: machine.online, defaultThere: account.is_default })
        if (!kinds.includes(kind)) kinds.push(kind)
        continue
      }
      const presence: AccountPresence = {
        machineId: machine.machineId,
        machine: machine.name,
        instance,
        terminal,
        state,
        online: machine.online,
        ...(account.broker ? { lender: account.broker.machine_name } : {}),
        managed: account.managed,
        canSignOut: account.can_sign_out,
        defaultThere: account.is_default,
        ...(account.directory ? { directory: account.directory } : {}),
        projects: account.projects,
      }
      let draft = drafts.get(id)
      if (!draft) {
        draft = { id, key, kind, terminalOnly: !key && terminal, summaries: [] }
        drafts.set(id, draft)
        if (!kinds.includes(kind)) kinds.push(kind)
      }
      draft.summaries.push({ machine, account, presence })
    }
  }

  return kinds.map((kind) => {
    const accounts = [...drafts.values()].filter((draft) => draft.kind === kind).map((draft) => build(draft, shared, local))
    const signedOutTerminals = signedOut.filter((entry) => entry.kind === kind).map(({ kind: _, ...entry }) => entry)
    const chosen = defaultId(kind, accounts, shared, local, signedOutTerminals.some((entry) => entry.machineId === local && entry.defaultThere))
    for (const account of accounts) account.isDefault = account.id === chosen
    markUnfollowed(kind, accounts, machines, shared)
    // Accounts keep the order they were first seen in; the shells' own accountless logins come last.
    accounts.sort((a, b) => Number(a.terminalOnly) - Number(b.terminalOnly))
    return { kind, accounts, signedOutTerminals }
  })
}

function build(draft: Draft, shared: AccountsShared, local: string | undefined): UnifiedAccount {
  const { summaries } = draft
  const profile = draft.key ? shared.profiles?.[draft.key] : undefined
  const named = summaries.find((s) => !s.presence.terminal && s.account.name !== CLI_ACCOUNT_NAME)
  const email = summaries.map((s) => s.account.identity?.email).find(Boolean)
  const plan = summaries.find((s) => isUsable(s.presence.state) && s.account.identity?.plan)?.account.identity?.plan ?? summaries.map((s) => s.account.identity?.plan).find(Boolean)
  const color = profile?.color || named?.account.color || summaries.map((s) => s.account.color).find(Boolean)
  const name = profile?.name?.trim() || named?.account.name || email || (draft.terminalOnly ? TERMINAL_ROW_NAME : summaries[0]!.account.name)
  let limit: LimitReading | null = null
  for (const { machine, account } of summaries) {
    const entry = limitsOn(machine, account)
    if (!entry) continue
    const reading = { entry, machineId: machine.machineId }
    limit = limit ? fresher(limit, reading, local) : reading
  }
  return {
    id: draft.id,
    key: draft.key,
    kind: draft.kind,
    terminalOnly: draft.terminalOnly,
    ...(email ? { email } : {}),
    ...(plan ? { plan } : {}),
    name,
    ...(color ? { color } : {}),
    manualOnly: profile?.manual_only ?? false,
    isDefault: false,
    presences: summaries.map((s) => s.presence),
    limit,
  }
}

/** Put each machine that isn't on the shared default onto that account, named after what it runs instead. */
function markUnfollowed(kind: ProviderKind, accounts: readonly UnifiedAccount[], machines: readonly MachineAccounts[], shared: AccountsShared) {
  const wanted = shared.defaults?.[kind]
  const account = wanted ? accounts.find((a) => a.key === wanted) : undefined
  if (!account) return
  for (const machine of ordered(machines)) {
    // A machine that is away, or still reports another default than the shared one, has nothing current to say.
    const entry = machine.online ? machine.unfollowed?.find((u) => u.kind === kind && u.key === wanted) : undefined
    if (!entry) continue
    const runs = (a: UnifiedAccount) => a.presences.some((p) => p.machineId === machine.machineId && p.instance === entry.running_on)
    // A borrowed sign-in can be the default's without the machine knowing its email: it does run it.
    if (runs(account)) continue
    const uses = accounts.find(runs)?.name ?? (isCliInstance(entry.running_on) ? TERMINAL_ROW_NAME : machine.accounts.find((a) => a.provider.kind === kind && a.provider.instance === entry.running_on)?.name ?? 'another account')
    ;(account.unfollowed ??= []).push({ machineId: machine.machineId, uses, hasAccount: entry.has_account })
  }
}

/** One default per agent: the shared choice, else the one of the machine this window is on, else any machine's. None when
 *  this machine's default is a signed-out terminal login: another machine's account is not its default. */
function defaultId(kind: ProviderKind, accounts: readonly UnifiedAccount[], shared: AccountsShared, local: string | undefined, localSignedOut: boolean): string | null {
  const wanted = shared.defaults?.[kind]
  if (wanted) {
    const found = accounts.find((account) => account.key === wanted || account.id === wanted)
    if (found) return found.id
  }
  const there = (machine: string | undefined) => accounts.find((account) => account.presences.some((p) => p.machineId === machine && p.defaultThere))
  return there(local)?.id ?? (localSignedOut ? null : accounts.find((account) => account.presences.some((p) => p.defaultThere))?.id ?? null)
}

export const defaultAccountOf = (groups: readonly HarnessGroup[], kind: ProviderKind): UnifiedAccount | undefined =>
  groups.find((group) => group.kind === kind)?.accounts.find((account) => account.isDefault)

/** The account behind one login of a machine. */
export const accountAt = (groups: readonly HarnessGroup[], machineId: string, provider: ProviderInstance): UnifiedAccount | undefined =>
  groups.find((group) => group.kind === provider.kind)?.accounts.find((account) => account.presences.some((p) => p.machineId === machineId && p.instance === (provider.instance || CLI_INSTANCE)))

/** The name of the account a thread runs on when it isn't the agent's default; null on the default, and when unknown. */
export function otherAccountName(groups: readonly HarnessGroup[], machineId: string, provider: ProviderInstance): string | null {
  const account = accountAt(groups, machineId, provider)
  return account && !account.isDefault && !account.terminalOnly ? account.name : null
}

// ── Per machine ──────────────────────────────────────────────────────────────

/** One account on one machine, merging its logins there (a terminal login and a named one with the same email). */
export interface MachineStanding {
  machineId: string
  machine: string
  online: boolean
  /** The best of the logins' states: usable beats signed out. */
  state: PresenceState
  /** The shell on that machine uses this account (its terminal login is not signed out). */
  terminal: boolean
  lender?: string
  presences: AccountPresence[]
}

const usesShell = (presence: AccountPresence) => presence.terminal && presence.state !== 'signed_out'

const RANK: Record<PresenceState, number> = { signed_in: 4, borrowed: 3, borrow_unreachable: 2, unknown: 1, signed_out: 0 }

export function standings(account: Pick<UnifiedAccount, 'presences'>): MachineStanding[] {
  const byMachine = new Map<string, MachineStanding>()
  for (const presence of account.presences) {
    const current = byMachine.get(presence.machineId)
    if (!current) {
      byMachine.set(presence.machineId, { machineId: presence.machineId, machine: presence.machine, online: presence.online, state: presence.state, terminal: usesShell(presence), ...(presence.lender ? { lender: presence.lender } : {}), presences: [presence] })
      continue
    }
    current.presences.push(presence)
    current.terminal ||= usesShell(presence)
    if (RANK[presence.state] > RANK[current.state]) {
      current.state = presence.state
      if (presence.lender) current.lender = presence.lender
      else delete current.lender
    }
  }
  return [...byMachine.values()]
}

/** What is left of the account's tightest limit, in percent; null when nothing is known. */
export function leftOf(account: Pick<UnifiedAccount, 'limit'>, now: number): number | null {
  const binding = account.limit ? bindingLimit(account.limit.entry.limits, now) : null
  return binding ? Math.max(0, Math.min(100, 100 - binding.used)) : null
}

// ── Which account to continue with ───────────────────────────────────────────

/** A weekly (or longer) window with less than this left is "almost out": not worth switching to. */
export const ALMOST_OUT_LEFT = 10
const WEEK_MINUTES = 7 * 24 * 60

export interface SwitchCandidate {
  instance: string
  limits?: ProviderLimits
  manualOnly: boolean
  /** Signed in or borrowing. */
  usable: boolean
}

type Limit = ProviderLimits['limits'][number]

/** The window that ran out: the most used limit of the account that hit the limit. */
export function exhaustedWindow(limits: ProviderLimits | undefined, now: number): Limit | undefined {
  if (!limits) return undefined
  const binding = bindingLimit(limits.limits, now)
  return binding && binding.used >= 90 ? binding.limit : undefined
}

function leftIn(limits: ProviderLimits, window: Limit | undefined, now: number): number | null {
  if (window?.window_minutes != null) {
    const same = limits.limits.filter((limit) => limit.window_minutes === window.window_minutes)
    const match = same.find((limit) => limit.name === window.name) ?? same[0]
    const used = match ? limitUsed(match, now) : null
    if (used !== null) return 100 - used
  }
  const binding = bindingLimit(limits.limits, now)
  return binding ? 100 - binding.used : null
}

/**
 * The account to continue with when `current` hit a limit, as the daemon chooses it (`ThreadTargetState.suggested_account`):
 * the most limit left in the window that ran out, skipping accounts almost out of their weekly limit and accounts marked
 * "Only when I choose". Accounts with no reading come after those with one. Null when none is eligible.
 */
export function suggestAccount(candidates: readonly SwitchCandidate[], current: string, now: number): string | null {
  const window = exhaustedWindow(candidates.find((candidate) => candidate.instance === current)?.limits, now)
  let best: { instance: string; score: number } | null = null
  for (const candidate of candidates) {
    if (candidate.instance === current || candidate.manualOnly || !candidate.usable) continue
    const limits = candidate.limits
    if (limits) {
      const tight = limits.limits.some((limit) => {
        if ((limit.window_minutes ?? 0) < WEEK_MINUTES) return false
        const used = limitUsed(limit, now)
        return used !== null && 100 - used < ALMOST_OUT_LEFT
      })
      if (tight) continue
      const binding = bindingLimit(limits.limits, now)
      if (binding && binding.used >= 100) continue
    }
    const left = limits ? leftIn(limits, window, now) : null
    const score = left ?? -1
    if (!best || score > best.score) best = { instance: candidate.instance, score }
  }
  return best?.instance ?? null
}

// ── The usage rail ───────────────────────────────────────────────────────────

export interface RailEntry {
  kind: ProviderKind
  /** The default account's limits, read on whichever machine has the freshest. */
  entry: ProviderLimits
  /** Where they were read. */
  machineId: string
  account?: UnifiedAccount
}

/**
 * One ring per agent: what is left of the default account's tightest limit, read across machines. An account signed in only
 * on another machine is read through it; when nothing has read it yet, there is no ring rather than another account's.
 */
export function railEntries(groups: readonly HarnessGroup[], own: readonly ProviderLimits[], primaryId: string): RailEntry[] {
  const kinds = [...own.map((entry) => entry.provider), ...groups.map((group) => group.kind)].filter((kind, i, all) => all.indexOf(kind) === i)
  return kinds.flatMap((kind): RailEntry[] => {
    const account = defaultAccountOf(groups, kind)
    const mine = own.find((entry) => entry.provider === kind)
    const here = !account || account.presences.some((p) => p.machineId === primaryId)
    const reading: LimitReading | null = account?.limit?.entry.limits.length ? account.limit : here && mine ? { entry: mine, machineId: primaryId } : null
    return reading && reading.entry.limits.length > 0 ? [{ kind, entry: reading.entry, machineId: reading.machineId, ...(account ? { account } : {}) }] : []
  })
}
