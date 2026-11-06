import { getState } from '../state.ts'
import { goPage } from '../nav/history.ts'
import { prCall } from './client.ts'
import { resolveKnownIssue } from './knownPulls.ts'
import { focusIssue } from './actions/store.ts'
import type { IssueTarget } from './tabTargets.ts'

/** A link to an issue of a known repository, or null: unknown repos and other URLs stay with the browser. */
export const knownIssueTarget = (url: string): Promise<IssueTarget | null> => resolveKnownIssue(url, getState().projects, prCall)

/** The Issues tab of the Pull requests page, on that issue. */
export function openIssueTarget(target: IssueTarget) {
  goPage('pulls')
  focusIssue(target)
}
