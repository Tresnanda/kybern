// The pull request page's view logic, with no UI: what a verdict button does, how the checks fold into rows, which reviewers show and
// how, and the prompts the "agent" buttons send. `assessPullRequest` and `groupChecks` (packages/kybern-client) decide the facts;
// this file only maps them to the sidebar.
import { checkBucket, type CheckGroup, type PrMenuAction, type PrPrimaryAction } from '../../../../../packages/kybern-client/src/pullRequests.ts'
import type { MergeMethod, PrActionKind, PrChecksSummary, PrDetailResult, PrReviewer } from '../../../../../packages/kybern-client/src/types.ts'

/** What a verdict button asks for. `agent` has no GitHub call: it opens a conversation. */
export type ActionRequest =
  | { kind: 'merge'; method?: MergeMethod; admin?: boolean }
  | { kind: 'enable_auto_merge'; method?: MergeMethod }
  | { kind: 'disable_auto_merge' }
  | { kind: 'update_branch' }
  | { kind: 'mark_ready' }
  | { kind: 'close' }
  | { kind: 'agent'; topic: 'conflicts' }

/** Merges and closes ask first; the rest are quick and reversible (auto-merge, update branch, ready for review). */
export function needsConfirmation(request: ActionRequest): boolean {
  return request.kind === 'merge' || request.kind === 'close'
}

export function requestForPrimary(primary: PrPrimaryAction): ActionRequest | null {
  switch (primary.kind) {
    case 'merge': return { kind: 'merge', method: primary.method }
    case 'auto_merge': return { kind: 'enable_auto_merge', method: primary.method }
    case 'cancel_auto_merge': return { kind: 'disable_auto_merge' }
    case 'update_branch': return { kind: 'update_branch' }
    case 'ready_for_review': return { kind: 'mark_ready' }
    case 'resolve_in_conversation': return { kind: 'agent', topic: 'conflicts' }
    default: return null
  }
}

export function requestForMenu(item: PrMenuAction): ActionRequest {
  switch (item.kind) {
    case 'merge': return { kind: 'merge', method: item.method }
    case 'merge_admin': return { kind: 'merge', method: item.method, admin: true }
    case 'auto_merge': return { kind: 'enable_auto_merge', method: item.method }
    case 'cancel_auto_merge': return { kind: 'disable_auto_merge' }
    case 'update_branch': return { kind: 'update_branch' }
    default: return { kind: 'close' }
  }
}

/** The `github.pr.action` kind a request calls. */
export const actionKind = (request: Exclude<ActionRequest, { kind: 'agent' }>): PrActionKind => request.kind

/** The label while the call runs. */
export function busyLabel(request: ActionRequest): string {
  switch (request.kind) {
    case 'merge': return 'Merging…'
    case 'enable_auto_merge': return 'Turning on…'
    case 'disable_auto_merge': return 'Cancelling…'
    case 'update_branch': return 'Updating…'
    case 'mark_ready': return 'Updating…'
    case 'close': return 'Closing…'
    case 'agent': return 'Opening…'
  }
}

/** A GitHub refusal, in words that say what to do next. */
export function actionFailure(error: string): string {
  const message = error.replace(/^Error:\s*/, '').trim()
  return /[.!?]$/.test(message) ? message : `${message}.`
}

// ---- checks ----

export interface CheckRows {
  /** Failed, then running: one row each. */
  open: CheckGroup[]
  /** Passed and skipped, folded into one disclosure row. */
  folded: CheckGroup[]
  passed: number
  skipped: number
}

export function foldChecks(groups: readonly CheckGroup[]): CheckRows {
  const open = groups.filter(g => g.bucket === 'failed' || g.bucket === 'pending')
  const folded = groups.filter(g => g.bucket === 'passed' || g.bucket === 'skipped')
  return { open, folded, passed: folded.filter(g => g.bucket === 'passed').reduce((n, g) => n + g.counts.passed, 0), skipped: folded.reduce((n, g) => n + g.counts.skipped, 0) }
}

/** "Required · shards 1/4 done"; empty for a plain passed check. */
export function groupSubtitle(group: CheckGroup): string {
  return [group.required ? 'Required' : '', group.detail].filter(Boolean).join(' · ')
}

/** "6 running · 1 passed · 5 skipped", failures first. */
export function checksSummaryLine(s: PrChecksSummary): string {
  return [s.failed ? `${s.failed} failed` : '', s.pending ? `${s.pending} running` : '', s.passed ? `${s.passed} passed` : '', s.skipped ? `${s.skipped} skipped` : ''].filter(Boolean).join(' · ')
}

/** Bar segments in the order failed → running → passed → skipped; `flex` is the check count. */
export function barSegments(s: PrChecksSummary): { bucket: 'failed' | 'pending' | 'passed' | 'skipped'; flex: number }[] {
  return (['failed', 'pending', 'passed', 'skipped'] as const).filter(b => s[b] > 0).map(bucket => ({ bucket, flex: s[bucket] }))
}

/** The folded row's words: "1 passed" and "5 skipped" count checks, not jobs. */
export function foldedWords(rows: CheckRows): string[] {
  return [rows.passed ? `${rows.passed} passed` : '', rows.skipped ? `${rows.skipped} skipped` : ''].filter(Boolean)
}

/** Every check of the groups of one bucket, for an agent prompt. */
export function failingNames(groups: readonly CheckGroup[]): string[] {
  return groups.filter(g => g.bucket === 'failed').map(g => g.label)
}

export { checkBucket }

// ---- reviewers ----

export type ReviewerState = 'changes_requested' | 'requested' | 'approved' | 'commented' | 'dismissed'
export interface ReviewerRow { login: string; avatar_url?: string; is_bot?: boolean; state: ReviewerState }

const REVIEWER_ORDER: ReviewerState[] = ['changes_requested', 'requested', 'approved', 'commented', 'dismissed']
const reviewerState = (state: string): ReviewerState => {
  switch (state.toUpperCase()) {
    case 'APPROVED': return 'approved'
    case 'CHANGES_REQUESTED': return 'changes_requested'
    case 'DISMISSED': return 'dismissed'
    case 'REQUESTED': return 'requested'
    default: return 'commented'
  }
}

export const REVIEWER_WORDS: Record<ReviewerState, string> = { changes_requested: 'Changes requested', requested: 'Requested', approved: 'Approved', commented: 'Commented', dismissed: 'Dismissed' }

/** One row per person, the most pressing state first. Names the old `reviewers` list has that `reviews` lacks count as requested. */
export function reviewerRows(detail: Pick<PrDetailResult, 'reviews' | 'reviewers'>): ReviewerRow[] {
  const rows = new Map<string, ReviewerRow>()
  for (const r of detail.reviews ?? ([] as PrReviewer[])) rows.set(r.login, { login: r.login, avatar_url: r.avatar_url, is_bot: r.is_bot, state: reviewerState(r.state) })
  for (const login of detail.reviewers) if (!rows.has(login)) rows.set(login, { login, state: 'requested' })
  return [...rows.values()].sort((a, b) => REVIEWER_ORDER.indexOf(a.state) - REVIEWER_ORDER.indexOf(b.state))
}

// ---- words ----

/** "3 commits": from the timeline counts when GitHub said. */
export function commitsPhrase(count: number | undefined): string {
  return count ? `${count} ${count === 1 ? 'commit' : 'commits'}` : ''
}

/** The heading's sentence parts: "wants to merge 3 commits into", or "merged …" once it is done. */
export function wantsToMerge(state: string, commits: number | undefined): string {
  const upper = state.toUpperCase()
  const what = commitsPhrase(commits)
  if (upper === 'MERGED') return what ? `merged ${what} into` : 'merged into'
  if (upper === 'CLOSED') return what ? `wanted to merge ${what} into` : 'wanted to merge into'
  return what ? `wants to merge ${what} into` : 'wants to merge into'
}

/** `#ff8a83`-like label colours from GitHub's six-digit hex; null for anything else. */
export function labelColor(color: string): string | null {
  return /^[\da-f]{6}$/i.test(color) ? `#${color}` : null
}

// ---- agent prompts ----

export interface PromptContext { number: number; title: string; url: string; head: string; base: string; sha: string }

/** What the agent is asked in the conversation the "Fix with agent", "Address feedback" and "Resolve in conversation" buttons open. */
export function agentPrompt(topic: 'conflicts' | 'checks' | 'feedback', ctx: PromptContext, subject: string[] = []): string {
  const intro = `Pull request #${ctx.number} "${ctx.title}" (${ctx.url}), branch ${ctx.head} into ${ctx.base}, at commit ${ctx.sha.slice(0, 8)}.`
  switch (topic) {
    case 'conflicts':
      return `${intro}\n\nThe branch conflicts with ${ctx.base}. Merge ${ctx.base} into ${ctx.head} (or rebase, if the history is clean), resolve every conflict keeping the intent of both sides, run the relevant tests and tell me what you changed. Do not push or merge without asking.`
    case 'checks':
      return `${intro}\n\n${subject.length === 1 ? `The check "${subject[0]}" is failing.` : `These checks are failing: ${subject.map(s => `"${s}"`).join(', ')}.`} Read the failing job logs with \`gh pr checks ${ctx.number}\` and \`gh run view --log-failed\`, find the cause, fix it on this branch and run the same checks locally if you can. Do not push without asking.`
    case 'feedback':
      return `${intro}\n\n${subject.length ? `${subject.join(', ')} requested changes.` : 'A reviewer requested changes.'} Read the review comments with \`gh pr view ${ctx.number} --comments\` and \`gh api repos/{owner}/{repo}/pulls/${ctx.number}/comments\`, address each one on this branch and summarize what you changed. Do not push or resolve threads without asking.`
  }
}
