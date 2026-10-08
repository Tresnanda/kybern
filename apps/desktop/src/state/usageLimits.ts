// Account plan limits per provider, shared by the rail glance, the Usage page,
// and the composer's usage popover.
//
// The daemon owns one cache per machine and pushes `usage.limits.changed`
// whenever it changes (a live read finished, a turn reported limits). This
// window asks with `cached: true` on attach, every minute while visible, and
// when it becomes visible again; each ask renews the daemon's interest and
// re-reads providers whose values have gone stale, so an unattended daemon
// spawns nothing while a visible window stays current.

import { create } from "zustand"

import { reloadOnHotUpdate } from "@/lib/hot"
import type { KybernClient } from "@/protocol"
import { USAGE_LIMITS_CHANGED_NOTIFICATION, type ProviderInstance, type ProviderKind, type ProviderLimits, type UsageLimitsParams, type UsageLimitsResult } from "@/protocol"
import { activeRuntime } from "@/state/rpc"
import { useStore } from "@/state/store"

const POLL_MS = 60_000

type UsageLimitsState = {
  ownerKey: string | null
  providers: ProviderLimits[]
  /** Per-account entries (`instance` set), kept from the asks that requested them. */
  accounts: ProviderLimits[]
  refreshing: ProviderKind[]
  loaded: boolean
}

export const useUsageLimits = create<UsageLimitsState>(() => ({ ownerKey: null, providers: [], accounts: [], refreshing: [], loaded: false }))

let feedClient: KybernClient | null = null
let generation = 0

const accountKey = (entry: ProviderLimits) => `${entry.provider}:${entry.instance ?? ""}`

/** Newer per-account entries replace older ones; accounts nobody asked about this time stay as they were. */
export function mergeAccountLimits(previous: ProviderLimits[], incoming: ProviderLimits[] | undefined): ProviderLimits[] {
  if (!incoming?.length) return previous
  const merged = new Map(previous.map((entry) => [accountKey(entry), entry]))
  for (const entry of incoming) merged.set(accountKey(entry), entry)
  return [...merged.values()]
}

function apply(token: number, result: UsageLimitsResult) {
  if (token !== generation) return
  useUsageLimits.setState((state) => ({ providers: result.providers, accounts: mergeAccountLimits(state.accounts, result.accounts), refreshing: result.refreshing ?? [], loaded: true }))
}

function ask(client: KybernClient, token: number, refresh = false, extra: Pick<UsageLimitsParams, "instances" | "all_accounts"> = {}) {
  void client.call("usage.limits", { cached: true, ...(refresh ? { refresh: true } : {}), ...extra }).then(
    (result) => apply(token, result),
    () => { /* keep the last values; the next ask or notification catches up */ },
  )
}

/** Follow the environment's account limits until the returned function is called. */
export function attachUsageFeed(client: KybernClient, ownerKey: string): () => void {
  const token = ++generation
  feedClient = client
  if (useUsageLimits.getState().ownerKey !== ownerKey) {
    useUsageLimits.setState({ ownerKey, providers: [], accounts: [], refreshing: [], loaded: false })
  }
  const off = client.onNotification(USAGE_LIMITS_CHANGED_NOTIFICATION, (params) => apply(token, params as UsageLimitsResult))
  const poll = () => { if (!document.hidden) ask(client, token) }
  const timer = setInterval(poll, POLL_MS)
  document.addEventListener("visibilitychange", poll)
  window.addEventListener("focus", poll)
  ask(client, token)
  return () => {
    off()
    clearInterval(timer)
    document.removeEventListener("visibilitychange", poll)
    window.removeEventListener("focus", poll)
    if (generation === token) feedClient = null
  }
}

function currentClient(): KybernClient | null {
  if (feedClient) return feedClient
  try { return activeRuntime().rpc() } catch { return null }
}

/**
 * Re-read every provider now. The daemon coalesces asks a few seconds apart.
 * `allAccounts` also reads every named account and `instances` reads the listed
 * ones; ask only while a surface that shows them is open, since each read can
 * start the agent's CLI.
 */
export function refreshUsageLimits({ allAccounts, instances }: { allAccounts?: boolean; instances?: ProviderInstance[] } = {}) {
  const client = currentClient()
  if (client) ask(client, generation, true, { ...(allAccounts ? { all_accounts: true } : {}), ...(instances?.length ? { instances } : {}) })
}

/** Like `refreshUsageLimits` but answered from the daemon's cache; stale accounts re-read in the background. */
export function loadAccountLimits({ allAccounts, instances }: { allAccounts?: boolean; instances?: ProviderInstance[] } = {}) {
  const client = currentClient()
  if (client) ask(client, generation, false, { ...(allAccounts ? { all_accounts: true } : {}), ...(instances?.length ? { instances } : {}) })
}

const NONE: ProviderLimits[] = []
const NOT_REFRESHING: ProviderKind[] = []

/**
 * Limits for the environment this window shows. Right after a switch the feed
 * still holds the previous environment's account until the new one attaches;
 * those values never render under the new environment.
 */
export function useAccountLimits(): ProviderLimits[] {
  const environmentId = useStore((s) => s.environmentId)
  return useUsageLimits((s) => (s.ownerKey === environmentId ? s.providers : NONE))
}

export function useRefreshingLimits(): ProviderKind[] {
  const environmentId = useStore((s) => s.environmentId)
  return useUsageLimits((s) => (s.ownerKey === environmentId ? s.refreshing : NOT_REFRESHING))
}

/** Limits of every account the window has asked about, for this environment. */
export function useAccountLimitEntries(): ProviderLimits[] {
  const environmentId = useStore((s) => s.environmentId)
  return useUsageLimits((s) => (s.ownerKey === environmentId ? s.accounts : NONE))
}

/**
 * Limits of one account. The CLI account ("default") falls back to the global
 * entry for the agent, which is its limits. Undefined before any are known.
 */
export function useAccountLimitsFor(kind: ProviderKind | undefined, instance: string | null | undefined): ProviderLimits | undefined {
  const accounts = useAccountLimitEntries()
  const global = useAccountLimits()
  if (!kind) return undefined
  if (!instance || instance === "default") return accounts.find((e) => e.provider === kind && e.instance === "default") ?? global.find((e) => e.provider === kind)
  return accounts.find((e) => e.provider === kind && e.instance === instance)
}

/** The current limits for one provider, or undefined before any are known. */
export function useProviderLimits(kind: ProviderKind | undefined): ProviderLimits | undefined {
  return useAccountLimits().find((entry) => entry.provider === kind)
}

reloadOnHotUpdate(import.meta.hot)
