import { isDeepStrictEqual } from 'node:util'
import type { UsageLimitsResult } from '../../../../packages/kybern-client/src/types.ts'
import { getNav, setNav } from './store.ts'

/** Cached minute polls and notifications can carry new arrays with the same
 * values. Preserve identities so an unchanged rail owns no React/native frame.
 * Compare every field, including freshness and retry metadata used by cards. */
export function applyUsageLimits(result: UsageLimitsResult) {
  const current = getNav(), refreshing = result.refreshing ?? []
  setNav({
    limits: isDeepStrictEqual(current.limits, result.providers) ? current.limits : result.providers,
    limitsRefreshing: isDeepStrictEqual(current.limitsRefreshing, refreshing) ? current.limitsRefreshing : refreshing,
  })
}
