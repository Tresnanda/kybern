import { getState } from '../state.ts'
import { goPage } from '../nav/history.ts'
import { prCall } from './client.ts'
import { resolveKnownRun } from './knownPulls.ts'
import { focusActions } from './actions/store.ts'
import type { ActionsTarget } from './tabTargets.ts'

/** A link to an Actions run or job of a known repository, or null: unknown repos and other URLs stay with the browser. */
export const knownRunTarget = (url: string): Promise<ActionsTarget | null> => resolveKnownRun(url, getState().projects, prCall)

/** The Actions tab of the Pull requests page on that run, and on the job's log when the target names one. */
export function openRunTarget(target: ActionsTarget) {
  goPage('pulls')
  focusActions(target)
}
