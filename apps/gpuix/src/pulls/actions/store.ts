// Which tab of the Pull requests page is showing, and what the Actions and Issues tabs open on: the PR page's checks link here with a
// repository and branch, a finished-run notice with the run itself, and an issue link in a chat with the issue. A tiny external store:
// no React state survives the page.
import { useSyncExternalStore } from 'react'
import type { ActionsRepo } from '../../../../../packages/kybern-client/src/actions.ts'
import type { IssueTarget } from '../tabTargets.ts'

export type PullsTab = 'pulls' | 'actions' | 'issues'
/** `jobId` and `attempt` open the run on that job's log (a link to a job, or an earlier attempt). */
export interface ActionsFocus extends ActionsRepo { branch?: string; runId?: number; jobId?: number; attempt?: number }
interface State { tab: PullsTab; focus: ActionsFocus | null; seq: number; issue: IssueTarget | null; issueSeq: number }

let state: State = { tab: 'pulls', focus: null, seq: 0, issue: null, issueSeq: 0 }
const listeners = new Set<() => void>()
const set = (next: Partial<State>) => { state = { ...state, ...next }; for (const l of [...listeners]) l() }

export const getPullsTab = () => state
export function usePullsTab<T>(select: (s: State) => T): T {
  return useSyncExternalStore(l => { listeners.add(l); return () => { listeners.delete(l) } }, () => select(state))
}
export const setPullsTab = (tab: PullsTab) => set({ tab })
/** Show the Actions tab on `focus`; `seq` lets the tab apply a repeat of the same focus. */
export const focusActions = (focus: ActionsFocus) => set({ tab: 'actions', focus, seq: state.seq + 1 })
/** Show the Issues tab on `issue`; `issueSeq` lets the tab apply a repeat of the same issue. */
export const focusIssue = (issue: IssueTarget) => set({ tab: 'issues', issue, issueSeq: state.issueSeq + 1 })
