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
import { USAGE_LIMITS_CHANGED_NOTIFICATION, type ProviderKind, type ProviderLimits, type UsageLimitsResult } from "@/protocol"
import { activeRuntime } from "@/state/rpc"
import { useStore } from "@/state/store"

const POLL_MS = 60_000

type UsageLimitsState = {
  ownerKey: string | null
  providers: ProviderLimits[]
  refreshing: ProviderKind[]
  loaded: boolean
}

export const useUsageLimits = create<UsageLimitsState>(() => ({ ownerKey: null, providers: [], refreshing: [], loaded: false }))

let feedClient: KybernClient | null = null
let generation = 0

function apply(token: number, result: UsageLimitsResult) {
  if (token !== generation) return
  useUsageLimits.setState({ providers: result.providers, refreshing: result.refreshing ?? [], loaded: true })
}

function ask(client: KybernClient, token: number, refresh = false) {
  void client.call("usage.limits", { cached: true, ...(refresh ? { refresh: true } : {}) }).then(
    (result) => apply(token, result),
    () => { /* keep the last values; the next ask or notification catches up */ },
  )
}

/** Follow the environment's account limits until the returned function is called. */
export function attachUsageFeed(client: KybernClient, ownerKey: string): () => void {
  const token = ++generation
  feedClient = client
  if (useUsageLimits.getState().ownerKey !== ownerKey) {
    useUsageLimits.setState({ ownerKey, providers: [], refreshing: [], loaded: false })
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

/** Re-read every provider now. The daemon coalesces asks a few seconds apart. */
export function refreshUsageLimits() {
  let client = feedClient
  if (!client) {
    try { client = activeRuntime().rpc() } catch { return }
  }
  ask(client, generation, true)
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

/** The current limits for one provider, or undefined before any are known. */
export function useProviderLimits(kind: ProviderKind | undefined): ProviderLimits | undefined {
  return useAccountLimits().find((entry) => entry.provider === kind)
}

reloadOnHotUpdate(import.meta.hot)
