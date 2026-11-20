// Pure option-building logic for the Add an account picker (`Account.tsx`): which agents appear
// and when Antigravity is disabled because this computer already has a signed-in account.
import type { AccountSummary, ProviderKind } from '../../../../packages/kybern-client/src/types.ts'
import { withoutSignIn } from '../shared/lib/accounts.ts'

/** One-line reason shown on the disabled Antigravity tile when this computer is already signed in. */
export const ANTIGRAVITY_ONE_ACCOUNT_REASON = 'Antigravity allows one account per computer.'

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
 * Whether this computer's Antigravity account is signed in, using the same `providers.accounts.list`
 * data and status rule as Settings › Accounts (`StatusCell`).
 */
export function isAntigravitySignedIn(accounts: readonly AccountSummary[], legacy = false): boolean {
  return accounts.some(
    (account) =>
      account.provider.kind === 'antigravity' &&
      (account.status === 'signed_in' || (!legacy && account.status === 'unknown' && !!account.identity)),
  )
}

/**
 * Providers offered by the Add an account picker: every sign-in agent except Grok Build.
 * Antigravity is listed, and disabled with a one-line reason when this computer is already signed in.
 */
export function accountPickerOptions(
  providers: readonly PickerProvider[],
  accounts: readonly AccountSummary[],
  legacy = false,
): AccountPickerOption[] {
  const antigravitySignedIn = isAntigravitySignedIn(accounts, legacy)
  return providers
    .filter((p) => p.kind !== 'grok-build' && !withoutSignIn(p.kind))
    .map((p) => {
      if (p.kind === 'antigravity' && p.available && antigravitySignedIn) {
        return { ...p, disabled: true, disabledReason: ANTIGRAVITY_ONE_ACCOUNT_REASON }
      }
      return { ...p, disabled: false }
    })
}
