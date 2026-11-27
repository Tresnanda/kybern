// Pure option-building logic for the Add an account picker (`Account.tsx`): which agents appear, and whether this
// machine can add an Antigravity account (always a named one, never the computer's own `agy` login).
import type { ProviderKind } from '../../../../packages/kybern-client/src/types.ts'
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
 * Why Antigravity can't be picked: adding it makes a named account, and the daemon on `host` is from before those.
 * `undefined` when it can be.
 */
export function antigravityAccountsBlocked(namedSupported: boolean, host: string): string | undefined {
  return namedSupported ? undefined : `Update Kybern on ${host} to add an Antigravity account.`
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
