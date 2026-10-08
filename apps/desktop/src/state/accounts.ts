// Accounts of each agent for the environment this window shows: the CLI account
// plus named accounts with their identity, status and projects.
//
// The daemon answers `providers.accounts.list`; a daemon that predates it
// answers "method not found", and the list is then built read-only from
// `settings.providers[*].accounts` (`legacy` is true). Reads happen on connect,
// when Settings › Accounts opens or the window regains focus, after every
// change, and when a sign-in finishes. An idle window never polls, because a
// list asks the daemon to probe each account's identity.

import { useMemo } from "react"
import { toast } from "sonner"
import { create } from "zustand"

import { PROVIDER_NAMES } from "@/lib/providerUsage"
import { accountFor, defaultAccountFor, isCliInstance, legacyAccounts } from "@/lib/accounts"
import { reloadOnHotUpdate } from "@/lib/hot"
import type { AccountLogin, AccountSummary, KybernClient, ProviderKind } from "@/protocol"
import { ACCOUNTS_LOGIN_CHANGED_NOTIFICATION, RpcCallError, codes } from "@/protocol"
import { errorText, rpc } from "@/state/rpc"
import { useStore } from "@/state/store"

interface EnvironmentAccounts {
  accounts: AccountSummary[]
  /** The daemon has no `providers.accounts.list`: read-only accounts from settings. */
  legacy: boolean
  loaded: boolean
}

interface AccountsState {
  byEnvironment: Record<string, EnvironmentAccounts>
}

const EMPTY: EnvironmentAccounts = { accounts: [], legacy: false, loaded: false }
const NO_ACCOUNTS: AccountSummary[] = []

export const useAccountsStore = create<AccountsState>(() => ({ byEnvironment: {} }))

function put(environmentId: string, next: Partial<EnvironmentAccounts>) {
  useAccountsStore.setState((state) => ({
    byEnvironment: { ...state.byEnvironment, [environmentId]: { ...(state.byEnvironment[environmentId] ?? EMPTY), ...next } },
  }))
}

export function isMethodNotFound(error: unknown): boolean {
  return error instanceof RpcCallError && error.code === codes.METHOD_NOT_FOUND
}

const inflight = new Map<string, Promise<boolean>>()

/**
 * Read the account list. Resolves true when the list is current, false when the
 * daemon could not be reached (the last list stays on screen). Concurrent asks
 * for one environment share one call.
 */
export function refreshAccounts({ probe = false }: { probe?: boolean } = {}): Promise<boolean> {
  const environmentId = useStore.getState().environmentId
  const key = `${environmentId}:${probe}`
  const running = inflight.get(key)
  if (running) return running
  const request = (async () => {
    try {
      const result = await rpc().call("providers.accounts.list", probe ? { refresh: true } : {})
      put(environmentId, { accounts: result.accounts, legacy: false, loaded: true })
      return true
    } catch (error) {
      if (isMethodNotFound(error)) {
        put(environmentId, { accounts: [], legacy: true, loaded: true })
        return true
      }
      return false
    } finally {
      inflight.delete(key)
    }
  })()
  inflight.set(key, request)
  return request
}

/** Follow sign-in progress for this environment until the returned function is called. */
export function attachAccountsFeed(client: KybernClient): () => void {
  const off = client.onNotification(ACCOUNTS_LOGIN_CHANGED_NOTIFICATION, (params) => {
    const login = params as AccountLogin
    if (login.phase === "signed_in") void refreshAccounts()
  })
  void refreshAccounts()
  return off
}

// ── Reading ──────────────────────────────────────────────────────────────────

function useEnvironmentAccounts(): EnvironmentAccounts {
  const environmentId = useStore((s) => s.environmentId)
  return useAccountsStore((s) => s.byEnvironment[environmentId] ?? EMPTY)
}

/** Whether the daemon predates account management, so accounts are read-only. */
export function useAccountsLegacy(): boolean {
  return useEnvironmentAccounts().legacy
}

export function useAccountsLoaded(): boolean {
  return useEnvironmentAccounts().loaded
}

/** Every account of the environment, or only one agent's. CLI account first, then named accounts. */
export function useAccounts(kind?: ProviderKind): AccountSummary[] {
  const entry = useEnvironmentAccounts()
  const settings = useStore((s) => s.settings)
  const providers = useStore((s) => s.providers)
  return useMemo(() => {
    let all = entry.accounts
    if (entry.legacy) {
      const kinds = providers.length ? providers.map((p) => p.kind) : (Object.keys(settings?.providers ?? {}) as ProviderKind[])
      all = legacyAccounts(settings?.providers, kinds)
    }
    if (!kind) return all.length ? all : NO_ACCOUNTS
    const ofKind = all.filter((account) => account.provider.kind === kind)
    return ofKind.length ? ofKind : NO_ACCOUNTS
  }, [entry, settings, providers, kind])
}

/** One account, or undefined while the list is unknown or the account is gone. */
export function useAccountFor(kind: ProviderKind | undefined, instance: string | null | undefined): AccountSummary | undefined {
  const accounts = useAccounts(kind)
  return kind ? accountFor(accounts, kind, instance) : undefined
}

/** The account new threads of the agent use. */
export function useDefaultAccount(kind: ProviderKind | undefined): AccountSummary | undefined {
  const accounts = useAccounts(kind)
  return kind ? defaultAccountFor(accounts, kind) : undefined
}

// ── Changing ─────────────────────────────────────────────────────────────────

/**
 * Make an account the default for its agent. The CLI account clears
 * `default_account`, so "default" is never stored.
 */
export async function makeDefaultAccount(account: AccountSummary): Promise<boolean> {
  const { kind, instance } = account.provider
  const state = useStore.getState()
  const settings = state.settings
  if (!settings) return false
  const current = settings.providers[kind] ?? { env: {} }
  const next = { ...settings, providers: { ...settings.providers, [kind]: { ...current, default_account: isCliInstance(instance) ? null : instance } } }
  state.set({ settings: next })
  try {
    const saved = await rpc().call("settings.update", { settings: next })
    useStore.getState().set({ settings: saved })
    await refreshAccounts()
    toast.success(`${account.name} is now the default for ${PROVIDER_NAMES[kind] ?? kind}. Running turns keep their account.`)
    return true
  } catch (error) {
    useStore.getState().set({ settings })
    toast.error("Unable to change the default account", { description: `${errorText(error)} Check your connection, then try again.` })
    return false
  }
}

// Stateful module: a hot update would drop the live subscriptions, so reload instead.
reloadOnHotUpdate(import.meta.hot)
