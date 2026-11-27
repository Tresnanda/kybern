// Pure option-building logic for the Add an account picker (`Account.tsx`): which agents appear,
// and whether this computer's own Antigravity login is signed in (the next one is a named account).
import type { AccountSummary, ProviderKind } from '../../../../packages/kybern-client/src/types.ts'
import { withoutSignIn } from '../shared/lib/accounts.ts'

export interface PickerProvider {
  kind: ProviderKind
  display_name: string
  available: boolean
}

export interface AccountPickerOption extends PickerProvider {
  disabled: boolean
  disabledReason?: string
}

/**
 * Whether this computer's own Antigravity login (the CLI account) is signed in, using the same
 * `providers.accounts.list` data and status rule as Settings › Accounts (`StatusCell`).
 */
export function isAntigravitySignedIn(accounts: readonly AccountSummary[], legacy = false): boolean {
  return accounts.some(
    (account) =>
      account.provider.kind === 'antigravity' &&
      account.provider.instance === 'default' &&
      (account.status === 'signed_in' || (!legacy && account.status === 'unknown' && !!account.identity)),
  )
}

/**
 * Whether picking Antigravity adds a named account (a profile of its own, signed in with a pasted
 * code) rather than this computer's own login: once that login is signed in. A daemon without
 * login records can't add one.
 */
export function addsNamedAntigravityAccount(accounts: readonly AccountSummary[], legacy = false): boolean {
  return !legacy && isAntigravitySignedIn(accounts, legacy)
}

/**
 * Why Antigravity can't be picked: this computer is signed in, so the next one is a named account,
 * and the daemon on `host` is from before named accounts. `undefined` when it can be.
 */
export function antigravityAccountsBlocked(accounts: readonly AccountSummary[], legacy: boolean, namedSupported: boolean, host: string): string | undefined {
  if (namedSupported || !isAntigravitySignedIn(accounts, legacy)) return undefined
  return `Update Kybern on ${host} to add another Antigravity account.`
}

/**
 * Providers offered by the Add an account picker: every sign-in agent except Grok Build. An installed
 * Antigravity is disabled with `antigravityBlocked` as its reason when one is given.
 */
export function accountPickerOptions(providers: readonly PickerProvider[], antigravityBlocked?: string): AccountPickerOption[] {
  return providers
    .filter((p) => p.kind !== 'grok-build' && !withoutSignIn(p.kind))
    .map((p) =>
      p.kind === 'antigravity' && p.available && antigravityBlocked
        ? { ...p, disabled: true, disabledReason: antigravityBlocked }
        : { ...p, disabled: false },
    )
}
