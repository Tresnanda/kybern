// The unified view's reads. The machine this window is at keeps its existing account stores (`usage/accounts.ts`); every
// other machine of the set is read through the hub (`clientFor`, never a new relay) once it is online, again when one of
// its sign-ins finishes or its settings change, and never on a timer: a list asks that daemon to probe identities.
// With one machine nothing extra is read.
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
import {
  ACCOUNTS_LOGIN_CHANGED_NOTIFICATION, USAGE_LIMITS_CHANGED_NOTIFICATION,
  type AccountOffer, type AccountSummary, type MachineId, type ProviderKind, type ProviderLimits, type ProviderStatus, type Settings, type UsageLimitsResult,
} from '../../../../packages/kybern-client/src/types.ts'
import { errorMessage } from '../../../../packages/kybern-client/src/problem.ts'
import { machineHub, useMachines, type MachineRow } from '../machines/index.ts'
import { useNav } from '../nav/store.ts'
import { activeEnvironment } from '../shell/environment.ts'
import { getClient, useApp } from '../state.ts'
import { askAccountLimits, mergeAccountLimits, refreshAccounts, useAccountLimitEntries, useAccounts, useAccountsFeed, useAccountsLegacy, useAccountsLoaded } from '../usage/accounts.ts'
import { featuresOf, fetchDaemonOffers, readShared, sharingFrom, supportsShared, type Sharing } from './adapter.ts'
import { applyAnswers, computeOffers, LOGIN_SHARING_FEATURE, type Offer } from './offers.ts'
import { keyOf, unifyAccounts, type HarnessGroup, type MachineAccounts } from './unified.ts'
import type { LendableAccount } from '../../../../packages/kybern-client/src/types.ts'

export interface RemoteSnapshot {
  state: MachineAccounts['state']
  accounts: AccountSummary[]
  providers: ProviderStatus[] | null
  limits: ProviderLimits[]
  globalLimits: ProviderLimits[]
  features: string[]
}

export type { Sharing }

interface State {
  remote: Readonly<Record<MachineId, RemoteSnapshot>>
  /** The settings of the machine this window is at (the shared preferences live there). */
  settings: Settings | null
  /** `accounts.offers`; null while the daemon cannot compute them. */
  daemonOffers: AccountOffer[] | null
  ratios: Readonly<Record<MachineId, number | null | undefined>>
  sharing: Sharing | null
  /** The offers' inputs were read at least once. */
  extrasRead: boolean
  /** Bumped when this computer's copy of the preferences changes. */
  prefs: number
}

const EMPTY: State = { remote: {}, settings: null, daemonOffers: null, ratios: {}, sharing: null, extrasRead: false, prefs: 0 }
let state: State = EMPTY
const listeners = new Set<() => void>()
const emit = (patch: Partial<State>) => { state = { ...state, ...patch }; for (const listener of listeners) listener() }
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
const select = <T,>(pick: (s: State) => T) => useSyncExternalStore(subscribe, () => pick(state))
/** This computer's preferences changed: read them again. */
export const prefsChanged = () => emit({ prefs: state.prefs + 1 })
export const adoptSettings = (settings: Settings) => emit({ settings })

const watched = new Set<MachineId>()
const reading = new Map<MachineId, Promise<void>>()
let extras: Promise<void> | undefined
let extrasAgain = false
let primary: KybernClient | null = null

/** The machine this window is at, by its machine id. */
export const primaryId = (): MachineId => machineHub().localMachineId ?? getClient()?.info?.machine_id ?? 'local'

/** The client for one machine's accounts: this window's connection, or the hub's. Throws `OfflineError` for an away one. */
export function clientOf(machineId: MachineId): KybernClient {
  if (machineId === primaryId()) {
    const client = getClient()
    if (client) return client
  }
  return machineHub().clientFor(machineId)
}

/** The machine whose daemon runs on this computer, where the browser can hand a sign-in straight back. */
export const computerId = (): MachineId | null => (activeEnvironment().local ? primaryId() : null)

const snapshot = (machineId: MachineId): RemoteSnapshot => state.remote[machineId] ?? { state: 'reading', accounts: [], providers: null, limits: [], globalLimits: [], features: [] }
const patchRemote = (machineId: MachineId, patch: Partial<RemoteSnapshot>) => emit({ remote: { ...state.remote, [machineId]: { ...snapshot(machineId), ...patch } } })

const isMethodNotFound = (error: unknown) => /method not found|-32601/i.test(errorMessage(error))

/** Read one other machine's accounts, agents and limits. `refresh` re-reads limits live (it can start the agent's CLI). */
export function readMachine(machineId: MachineId, { probe = false, refresh = false }: { probe?: boolean; refresh?: boolean } = {}): Promise<void> {
  const running = reading.get(machineId)
  if (running && !probe && !refresh) return running
  const run = (async () => {
    let client: KybernClient
    try { client = machineHub().clientFor(machineId) } catch { patchRemote(machineId, { state: 'unreachable' }); return }
    const features = machineHub().connections().find((c) => c.record.machineId === machineId)?.info?.features ?? featuresOf(client)
    if (!state.remote[machineId]) patchRemote(machineId, { features })
    const [accounts, providers, limits] = await Promise.allSettled([
      client.call('providers.accounts.list', probe ? { refresh: true } : {}),
      client.call('providers.list', {}),
      client.call('usage.limits', { cached: true, all_accounts: true, ...(refresh ? { refresh: true } : {}) }),
    ])
    if (accounts.status === 'rejected') { patchRemote(machineId, { state: isMethodNotFound(accounts.reason) ? 'legacy' : 'unreachable', features }); return }
    const list = accounts.value.accounts ?? []
    const legacy = features.length > 0 && !supportsShared(features) && !list.some((account) => !!keyOf(account))
    patchRemote(machineId, {
      state: legacy ? 'legacy' : 'ready',
      features,
      accounts: legacy ? [] : list,
      ...(providers.status === 'fulfilled' ? { providers: providers.value.providers ?? null } : {}),
      ...(limits.status === 'fulfilled' ? { limits: mergeAccountLimits(snapshot(machineId).limits, limits.value.accounts), globalLimits: limits.value.providers ?? [] } : {}),
    })
  })().finally(() => { if (reading.get(machineId) === run) reading.delete(machineId) })
  reading.set(machineId, run)
  return run
}

/** Follow one other machine: its finished sign-ins, limits and settings. Subscriptions survive its reconnects. */
function watch(machineId: MachineId) {
  if (watched.has(machineId)) return
  let handle: KybernClient
  try { handle = machineHub().set.handleFor(machineId) } catch { return }
  watched.add(machineId)
  // For the life of the app: a machine's handle keeps its subscriptions across reconnects.
  handle.onNotification(ACCOUNTS_LOGIN_CHANGED_NOTIFICATION, (params) => {
    if ((params as { phase?: string }).phase === 'signed_in') { void readMachine(machineId); void refreshOfferInputs() }
  })
  handle.onNotification(USAGE_LIMITS_CHANGED_NOTIFICATION, (params) => {
    const result = params as UsageLimitsResult
    if (state.remote[machineId]) patchRemote(machineId, { limits: mergeAccountLimits(snapshot(machineId).limits, result.accounts), globalLimits: result.providers ?? [] })
  })
  handle.onNotification('settings.changed', () => void readMachine(machineId))
}

/** The shared preferences, offers, uptime and who shares sign-ins: everything the offers and the page need besides accounts. */
export function refreshOfferInputs(): Promise<void> {
  if (extras) { extrasAgain = true; return extras }
  const run = (async () => {
    do {
      extrasAgain = false
      const client = getClient()
      if (!client || client.status !== 'open') return
      const many = machineHub().machineCount > 1
      const features = featuresOf(client)
      const [settings, offers, network, sharing] = await Promise.allSettled([
        client.call('settings.get', {}),
        fetchDaemonOffers(client),
        many ? client.call('network.status', {}) : Promise.resolve(null),
        many && features.includes(LOGIN_SHARING_FEATURE) ? client.call('login.broker.status', {}) : Promise.resolve(null),
      ])
      if (getClient() !== client) { extrasAgain = true; continue }
      const members = network.status === 'fulfilled' ? network.value?.members ?? [] : []
      emit({
        ...(settings.status === 'fulfilled' ? { settings: settings.value } : {}),
        daemonOffers: offers.status === 'fulfilled' ? offers.value : state.daemonOffers,
        ratios: Object.fromEntries(members.map((member) => [member.machine_id, member.online_ratio_7d])),
        sharing: sharing.status === 'fulfilled' ? sharingFrom(sharing.value, members) : null,
        extrasRead: true,
      })
    } while (extrasAgain)
  })().finally(() => { if (extras === run) extras = undefined })
  extras = run
  return run
}

/** The machine count the offers' inputs were last read for, by connection: every surface mounting must not read them again
 *  (`network.status` also ticks the daemon's discovery). A change of settings, a sign-in or a page opening reads them. */
let inputsFor: { client: KybernClient; machines: number } | null = null

/** Follow the machine this window is at. */
function watchPrimary(client: KybernClient) {
  if (primary === client) return
  primary = client
  client.onNotification('settings.changed', (params) => {
    const settings = (params as { settings?: Settings })?.settings
    if (settings && getClient() === client) emit({ settings })
    void refreshOfferInputs()
  })
  client.onNotification(ACCOUNTS_LOGIN_CHANGED_NOTIFICATION, (params) => { if ((params as { phase?: string }).phase === 'signed_in') void refreshOfferInputs() })
}

/** Everything again, now: after a change, and when the Accounts page opens. */
export async function refreshAllAccounts({ probe = false }: { probe?: boolean } = {}) {
  const local = primaryId()
  askAccountLimits()
  await Promise.all([
    refreshAccounts({ probe }),
    refreshOfferInputs(),
    ...machineHub().connections().filter((c) => c.record.machineId !== local && !c.record.paused).map((c) => readMachine(c.record.machineId, { probe })),
  ])
}

const others = (rows: readonly MachineRow[], local: MachineId) => rows.filter((row) => row.machineId !== local && !row.paused)

/** Read the other machines while a surface shows accounts (and the rail, always mounted, once per connection). */
export function useRemoteAccountsFeed(rows: readonly MachineRow[]) {
  useAccountsFeed()
  const open = useApp((s) => s.status === 'open')
  const local = primaryId()
  const online = others(rows, local).filter((row) => !row.offline).map((row) => `${row.machineId}:${row.status}`).sort().join(',')
  const seen = useRef<ReadonlySet<string> | null>(null)
  useEffect(() => {
    const client = getClient()
    if (!open || !client) return
    watchPrimary(client)
    // A machine joining or leaving changes the offers; a status change alone does not.
    if (inputsFor?.client === client && inputsFor.machines === rows.length) return
    inputsFor = { client, machines: rows.length }
    void refreshOfferInputs()
  }, [open, rows.length])
  useEffect(() => {
    if (!open) return
    const before = seen.current
    const now = new Set(online.split(',').filter(Boolean))
    seen.current = now
    for (const entry of now) {
      const id = entry.slice(0, entry.lastIndexOf(':'))
      watch(id)
      // Read a machine that came back while this surface was open, and one nothing has read yet.
      if (before ? !before.has(entry) : state.remote[id]?.state !== 'ready') void readMachine(id)
    }
  }, [open, online])
}

export interface UnifiedView {
  machines: MachineAccounts[]
  groups: HarnessGroup[]
  /** The shared preferences (the daemon's, or this computer's). */
  shared: ReturnType<typeof readShared>
  /** The daemon this window is at stores the shared preferences. */
  supportsShared: boolean
  primaryId: MachineId
  /** The machine this window is at is too old to list accounts. */
  legacy: boolean
  loaded: boolean
  sharing: Sharing | null
}

/** Every account of every machine, merged. Mount `useUnifiedFeed` with it. */
export function useUnifiedAccounts(rows: readonly MachineRow[]): UnifiedView {
  const accounts = useAccounts()
  const legacy = useAccountsLegacy()
  const loaded = useAccountsLoaded()
  const limits = useAccountLimitEntries()
  const globalLimits = useNav((s) => s.limits)
  const providers = useNav((s) => s.providers)
  const providersLoaded = useNav((s) => s.providersLoaded)
  const online = useApp((s) => s.status === 'open')
  const remote = select((s) => s.remote)
  const settings = select((s) => s.settings)
  const prefs = select((s) => s.prefs)
  const sharing = select((s) => s.sharing)
  const local = primaryId()
  const features = featuresOf(getClient())
  const featureKey = features.join(',')
  const machines = useMemo(() => {
    const here: MachineAccounts = {
      machineId: local,
      name: rows.find((row) => row.machineId === local)?.name ?? activeEnvironment().name,
      isLocal: true,
      online,
      state: legacy ? 'legacy' : loaded ? 'ready' : 'reading',
      accounts,
      providers: providersLoaded ? providers : null,
      limits,
      globalLimits,
      features,
    }
    return [here, ...others(rows, local).map((row): MachineAccounts => {
      const read = remote[row.machineId]
      return {
        machineId: row.machineId,
        name: row.name,
        isLocal: false,
        online: !row.offline,
        state: row.offline ? 'unreachable' : read?.state ?? 'reading',
        accounts: read?.accounts ?? [],
        providers: read?.providers ?? null,
        limits: read?.limits ?? [],
        globalLimits: read?.globalLimits ?? [],
        features: read?.features ?? [],
      }
    })]
  }, [local, rows, online, legacy, loaded, accounts, providers, providersLoaded, limits, globalLimits, featureKey, remote])
  const shared = useMemo(() => readShared(settings, features), [settings, featureKey, prefs])
  const groups = useMemo(() => unifyAccounts(machines, { shared }), [machines, shared])
  return { machines, groups, shared, supportsShared: supportsShared(features), primaryId: local, legacy, loaded: loaded && machines.every((m) => m.state !== 'reading'), sharing }
}

/**
 * The merged accounts for a row that only needs a name (a delegated agent's account): no reads, and no limits, so nothing
 * that changes while turns run re-renders it.
 */
export function useAccountNames(): { groups: HarnessGroup[]; primaryId: MachineId } {
  const rows = useMachines()
  const accounts = useAccounts()
  const remote = select((s) => s.remote)
  const settings = select((s) => s.settings)
  const prefs = select((s) => s.prefs)
  const local = primaryId()
  const groups = useMemo(() => {
    const named = (machineId: MachineId, name: string, isLocal: boolean, list: readonly AccountSummary[]): MachineAccounts =>
      ({ machineId, name, isLocal, online: true, state: 'ready', accounts: list, providers: null, limits: [], globalLimits: [], features: [] })
    return unifyAccounts([
      named(local, '', true, accounts),
      ...others(rows, local).map((row) => named(row.machineId, row.name, false, remote[row.machineId]?.accounts ?? [])),
    ], { shared: readShared(settings, featuresOf(getClient())) })
  }, [local, rows, accounts, remote, settings, prefs])
  return { groups, primaryId: local }
}

/** The view alone, for a surface that is always there (a composer): what other surfaces read, without reading again. */
export function useAccountsView(): UnifiedView {
  return useUnifiedAccounts(useMachines())
}

/** The view plus its feed, for a surface that shows accounts. */
export function useAccountsEverywhere(): UnifiedView {
  const rows = useMachines()
  useRemoteAccountsFeed(rows)
  return useUnifiedAccounts(rows)
}

/** The offers as they stand: the daemon's, else worked out here, each marked with the answer already given. */
export function useOffers(view: UnifiedView): { offers: Offer[]; ready: boolean } {
  const daemon = select((s) => s.daemonOffers)
  const ratios = select((s) => s.ratios)
  const extrasRead = select((s) => s.extrasRead)
  const offers = useMemo(
    () => applyAnswers(daemon ?? computeOffers({ groups: view.groups, machines: view.machines, ratios, sharing: view.sharing?.machineId ?? null }), view.shared.offers),
    [daemon, view.groups, view.machines, view.shared, view.sharing, ratios],
  )
  return { offers, ready: extrasRead && view.loaded }
}

/** What the sharing machine can lend: its own signed-in accounts of the lendable agents. */
export function lendableOn(groups: readonly HarnessGroup[], machineId: MachineId): LendableAccount[] {
  return groups.flatMap((group) => group.accounts.flatMap((account) => account.presences
    .filter((p) => p.machineId === machineId && p.state === 'signed_in')
    .map((p) => ({ provider: account.kind as ProviderKind, account: p.instance, name: account.name, ...(account.email ? { email: account.email } : {}) }))))
}
