// The daemon calls that a current daemon may not have yet, in one place. A daemon lists `accounts.shared.v1` when it
// stores and syncs `Settings.accounts_shared`, computes offers and may sign a terminal login in or out. Without it the
// page still works: names and "Only when I choose" are kept on this computer, the default is set on each machine, and
// offers are worked out here.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import type { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
import { ACCOUNTS_SHARED_FEATURE, LOGIN_HANDOFF_FEATURE, type AccountOffer, type AccountsShared, type LoginHandoffParams, type ProviderKind, type Settings } from '../../../../packages/kybern-client/src/types.ts'
import { errorMessage } from '../../../../packages/kybern-client/src/problem.ts'
import { configDir } from '../environments/registry.ts'
import { setSettings } from '../settings/store.ts'

export const supportsShared = (features: readonly string[] | undefined | null) => !!features?.includes(ACCOUNTS_SHARED_FEATURE)
export const featuresOf = (client: Pick<KybernClient, 'info'> | null | undefined): string[] => client?.info?.features ?? []

const isMethodNotFound = (error: unknown) => /method not found|-32601|unknown method/i.test(errorMessage(error))

/** `accounts.offers`, or null when the daemon cannot compute offers (they are then worked out here). */
export async function fetchDaemonOffers(client: KybernClient): Promise<AccountOffer[] | null> {
  if (!supportsShared(featuresOf(client))) return null
  try { return (await client.call('accounts.offers', {})).offers } catch (error) {
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
    const saved = await client.call('settings.update', { settings: { ...settings, accounts_shared: change(settings.accounts_shared ?? {}) } })
    setSettings(saved)
    return saved
  })
  writes = run.catch(() => {})
  return run
}
