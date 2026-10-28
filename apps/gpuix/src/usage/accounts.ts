import {readAccounts} from '../requests/accounts.ts'
// Accounts of each agent for the environment this window shows, and their plan limits
// (`state/accounts.ts` + the per-account half of `state/usageLimits.ts`).
//
// The daemon answers `providers.accounts.list`; a daemon that predates it answers
// "method not found" and the list is then built read-only from settings (`legacy`).
// Reads happen when a surface that shows accounts opens (Settings › Accounts, the
// rail usage card, the Add account sheet) and after every change; an idle window never
// polls, because a list asks the daemon to probe each account's identity.
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { accountFor, defaultAccountFor, isCliInstance, legacyAccounts } from '../shared/lib/accounts.ts'
import { PROVIDER_NAMES } from '../shared/lib/providerUsage.ts'
import { USAGE_LIMITS_CHANGED_NOTIFICATION, type AccountSummary, type ProviderInstance, type ProviderKind, type ProviderLimits, type ProviderSettings, type UsageLimitsParams, type UsageLimitsResult } from '../../../../packages/kybern-client/src/types.ts'
import { errorText } from '../nav/actions.ts'
import { useNav } from '../nav/store.ts'
import { toast } from '../shell/toasts.tsx'
import { onEnvironmentChange } from '../shell/environment.ts'
import { getClient, useApp } from '../state.ts'
import { setSettings, latestSettings, useSettings } from '../settings/store.ts'
import { refreshComposerAccounts } from '../composer/store.ts'

interface State {
  accounts: AccountSummary[]
  /** The daemon has no `providers.accounts.list`: read-only accounts from settings. */
  legacy: boolean
  loaded: boolean
  /** `kind:instance` of an account that was just added; its row flashes once. */
  flash: string | null
  /** Per-account plan limits (`instance` set), from the asks that requested them. */
  limits: ProviderLimits[]
  /** Element id the Usage page scrolls to when it opens. */
  usageAnchor: string | null
}
const EMPTY: State = { accounts: [], legacy: false, loaded: false, flash: null, limits: [], usageAnchor: null }
let state: State = EMPTY
const listeners = new Set<() => void>()
const emit = (patch: Partial<State>) => { state = { ...state, ...patch }; for (const listener of listeners) listener() }
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
const select = <T,>(pick: (s: State) => T) => useSyncExternalStore(subscribe, () => pick(state))
let generation = 0
onEnvironmentChange(() => { generation++; inflight.clear(); emit({ ...EMPTY }) })

const isMethodNotFound = (error: unknown) => /method not found|-32601/i.test(errorText(error))
const inflight = new Map<string, Promise<boolean>>()

/**
 * Read the account list. Resolves true when the list is current, false when the daemon
 * could not be reached (the last list stays). Concurrent asks share one call.
 */
export function refreshAccounts({ probe = false }: { probe?: boolean } = {}): Promise<boolean> {
  const client = getClient()
  if (!client) return Promise.resolve(false)
  const key = String(probe)
  const running = inflight.get(key)
  if (running) return running
  const at = generation
  const request = (async () => {
    try {
      const result = await readAccounts(client,probe)
      if (generation === at) {
        emit({ accounts: result.accounts, legacy: false, loaded: true })
        void refreshComposerAccounts(result.accounts)
      }
      return true
    } catch (error) {
      if (isMethodNotFound(error)) { if (generation === at) emit({ accounts: [], legacy: true, loaded: true }); return true }
      return false
    } finally {
      inflight.delete(key)
    }
  })()
  inflight.set(key, request)
  return request
}

// ── Reading ──────────────────────────────────────────────────────────────────

/** Loads the list the first time a surface that shows accounts mounts, and when a sign-in finishes. */
export function useAccountsFeed() {
  const open = useApp((s) => s.status === 'open')
  useEffect(() => {
    const client = getClient()
    if (!open || !client) return
    void refreshAccounts()
    return client.onNotification('providers.accounts.login.changed', (params) => {
      if ((params as { phase?: string }).phase === 'signed_in') void refreshAccounts()
    })
  }, [open])
}

export const useAccountsLegacy = () => select((s) => s.legacy)
export const useAccountsLoaded = () => select((s) => s.loaded)

/** Every account of the environment, or only one agent's. CLI account first, then named accounts. */
export function useAccounts(kind?: ProviderKind): AccountSummary[] {
  // Only the two fields read here, so the always-mounted rail does not re-render on a flash or a load flag.
  const list = select((s) => s.accounts)
  const legacy = select((s) => s.legacy)
  const { settings } = useSettings()
  const providers = useNav((s) => s.providers)
  return useMemo(() => {
    let all = list
    if (legacy) {
      const kinds = providers.length ? providers.map((p) => p.kind) : (Object.keys(settings?.providers ?? {}) as ProviderKind[])
      all = legacyAccounts(settings?.providers, kinds)
    }
    return kind ? all.filter((account) => account.provider.kind === kind) : all
  }, [list, legacy, providers, settings, kind])
}

export function useDefaultAccount(kind: ProviderKind | undefined): AccountSummary | undefined {
  const accounts = useAccounts(kind)
  return kind ? defaultAccountFor(accounts, kind) : undefined
}

export function useAccountFor(kind: ProviderKind | undefined, instance: string | null | undefined): AccountSummary | undefined {
  const accounts = useAccounts(kind)
  return kind ? accountFor(accounts, kind, instance) : undefined
}

let flashTimer: ReturnType<typeof setTimeout> | undefined
/** Flash the row of a newly added account once (600 ms). */
export function flashAccount(kind: ProviderKind, instance: string) {
  clearTimeout(flashTimer)
  emit({ flash: `${kind}:${instance}` })
  flashTimer = setTimeout(() => emit({ flash: null }), 900)
}
export const useAccountFlash = (kind: ProviderKind, instance: string) => select((s) => s.flash === `${kind}:${instance}`)

// ── Changing ─────────────────────────────────────────────────────────────────

/**
 * Save a change to one agent's provider settings. Reads the settings first when no
 * surface has, and the settings store follows the daemon's answer. The error is thrown
 * for the caller to word.
 */
export async function updateProviderSettings(kind: ProviderKind, change: (current: ProviderSettings) => ProviderSettings): Promise<void> {
  const client = getClient()
  if (!client) throw new Error('Not connected to kybernd')
  const settings = latestSettings() ?? (await client.call('settings.get', {}))
  const next = { ...settings, providers: { ...settings.providers, [kind]: change(settings.providers[kind] ?? { env: {} }) } }
  setSettings(await client.call('settings.update', { settings: next }))
  await refreshAccounts()
}

/** Make an account the default for its agent. The CLI account clears `default_account`, so "default" is never stored. */
export async function makeDefaultAccount(account: AccountSummary): Promise<boolean> {
  const { kind, instance } = account.provider
  try {
    await updateProviderSettings(kind, (current) => ({ ...current, default_account: isCliInstance(instance) ? null : instance }))
    toast.success(`${account.name} is now the default for ${PROVIDER_NAMES[kind] ?? kind}. Running turns keep their account.`)
    return true
  } catch (error) {
    toast.error('Unable to change the default account', { description: `${errorText(error)} Check your connection, then try again.` })
    return false
  }
}

// ── Account limits ───────────────────────────────────────────────────────────

/** Newer per-account entries replace older ones; accounts nobody asked about this time stay as they were. */
export function mergeAccountLimits(previous: ProviderLimits[], incoming: ProviderLimits[] | undefined): ProviderLimits[] {
  if (!incoming?.length) return previous
  const key = (entry: ProviderLimits) => `${entry.provider}:${entry.instance ?? ''}`
  const merged = new Map(previous.map((entry) => [key(entry), entry]))
  for (const entry of incoming) merged.set(key(entry), entry)
  return [...merged.values()]
}

/**
 * Read per-account limits. `refresh` re-reads now (each read can start the agent's CLI, so ask only
 * while a surface that shows them is open); without it the daemon answers from its cache.
 */
export function askAccountLimits({ refresh = false }: { refresh?: boolean } = {}) {
  readAccountLimits({ all_accounts: true, ...(refresh ? { refresh: true } : {}) })
}

/** Like `askAccountLimits` for the listed accounts only, answered from the daemon's cache (`loadAccountLimits`). */
export function loadAccountLimits(instances: ProviderInstance[]) {
  readAccountLimits({ instances })
}

function readAccountLimits(extra: Pick<UsageLimitsParams, 'all_accounts' | 'refresh' | 'instances'>) {
  const client = getClient()
  if (!client) return
  const at = generation
  void client.call('usage.limits', { cached: true, ...extra }).then(
    (result) => { if (generation === at) emit({ limits: mergeAccountLimits(state.limits, result.accounts) }) },
    () => { /* keep the last values; the next ask or notification catches up */ },
  )
}

/** Follow `usage.limits.changed` for per-account entries while a surface that shows them is mounted. */
export function useAccountLimitEntries(): ProviderLimits[] {
  const open = useApp((s) => s.status === 'open')
  useEffect(() => {
    const client = getClient()
    if (!open || !client) return
    return client.onNotification(USAGE_LIMITS_CHANGED_NOTIFICATION, (params) => emit({ limits: mergeAccountLimits(state.limits, (params as UsageLimitsResult).accounts) }))
  }, [open])
  return select((s) => s.limits)
}

// ── Usage page link ──────────────────────────────────────────────────────────

export const usageAnchorId = (kind: ProviderKind, instance: string) => `usage-account-${kind}-${instance}`

/** Remember which account's card the Usage page should scroll to when it opens. */
export function setUsageAnchor(kind: ProviderKind, instance: string) { emit({ usageAnchor: usageAnchorId(kind, instance) }) }

/** The anchor the Usage page should scroll to, once; null when there is none. */
export function takeUsageAnchor(): string | null {
  const anchor = state.usageAnchor
  if (anchor) emit({ usageAnchor: null })
  return anchor
}
