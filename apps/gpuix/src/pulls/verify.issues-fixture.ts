/** Fake `github.issue.list` and `github.issue.detail` answers for the Issues tab check (`verify.issues.ts`). Nothing reaches GitHub. */
import type { Issue, IssueDetailResult, IssueListParams, IssueListResult, PrLabel } from '../../../../packages/kybern-client/src/types.ts'

export const ISSUE_LABELS: PrLabel[] = [
  { name: 'bug', color: 'd73a4a' }, { name: 'design', color: '8250df' }, { name: 'desktop', color: '57606a' },
  { name: 'enhancement', color: '0969da' }, { name: 'github', color: 'bf8700' }, { name: 'mobile', color: '1a7f37' },
]
const label = (name: string): PrLabel => ISSUE_LABELS.find(l => l.name === name)!
const hours = (now: string, h: number) => new Date(Date.parse(now) - h * 3_600_000).toISOString()

/** Every issue the fixture knows, newest first. */
export function allIssues(now: string): Issue[] {
  const base = { state: 'OPEN', author: 'tresnanda', url: '', created_at: now, updated_at: now }
  const issue = (number: number, title: string, labels: string[], over: Partial<Issue> = {}): Issue => ({
    ...base, number, title, url: `https://github.com/acme/api/issues/${number}`, labels: labels.map(label), created_at: hours(now, 400 - number), updated_at: hours(now, 300 - number), ...over,
  })
  return [
    issue(249, 'Model picker: vertical harness rail instead of a horizontal tab strip', ['enhancement', 'design']),
    issue(246, 'Composer: redesign the multi-select attachment list', ['design', 'desktop', 'enhancement'], { linked_pull_requests: [252] }),
    issue(241, 'Terminal: Ctrl+Backspace deletes the whole line on Windows', ['bug', 'desktop'], { author: 'arifw', assignees: [{ login: 'grace' }] }),
    issue(231, 'Actionable errors, phase 2: shared Problem component, toast variant and fix actions in GPUIX', ['enhancement']),
    issue(228, 'Mobile: pairing fails when the daemon is reached over a Tailscale address', ['bug', 'mobile'], { author: 'dimas-p', assignees: [{ login: 'ada' }] }),
    issue(217, 'GitHub: list and open a repository’s issues', ['enhancement', 'github'], { linked_pull_requests: [250, 226], milestone: '0.22.0', assignees: [{ login: 'tresnanda' }] }),
    issue(214, 'Sidebar: archived threads come back after the daemon restarts', ['bug'], { author: 'arifw' }),
    issue(213, 'Notes: checklist items lose their order after a sync', ['bug'], { author: 'dimas-p', state: 'CLOSED', state_reason: 'COMPLETED' }),
    issue(190, 'Sync: a deleted note returns on the second machine', ['bug'], { author: 'ada', state: 'CLOSED', state_reason: 'NOT_PLANNED' }),
    ...Array.from({ length: 40 }, (_, i) => issue(180 - i, `Older issue ${180 - i}: smaller fixes and cleanups`, i % 3 ? ['bug'] : ['enhancement'], { author: 'arifw' })),
  ]
}

/** `github.issue.list`: the filters applied to the fixture, paged like the daemon (`limit`, `offset`, `has_more`). */
export function issueList(now: string, p: Partial<IssueListParams>): IssueListResult {
  const search = (p.search ?? '').toLowerCase()
  const matching = allIssues(now)
    .filter(i => p.state === 'closed' ? i.state === 'CLOSED' : p.state === 'all' || i.state === 'OPEN')
    .filter(i => !search || i.title.toLowerCase().includes(search))
    .filter(i => (p.labels ?? []).every(name => i.labels?.some(l => l.name === name)))
    .filter(i => !p.assignee || (p.assignee === '@me' ? i.assignees?.some(a => a.login === 'tresnanda') : i.assignees?.some(a => a.login === p.assignee)))
  const offset = p.offset ?? 0, limit = p.limit ?? 30
  return { issues: matching.slice(offset, offset + limit), has_more: matching.length > offset + limit, ...(offset === 0 ? { labels: ISSUE_LABELS } : {}) }
}

const BODY = `Kybern shows a project’s pull requests and Actions runs, but not its issues. To read or triage issues you have to leave the app.

## Proposal

- \`github.issue.list\` and \`github.issue.detail\` through \`gh\`, as \`github.pr.*\` does today.
- An Issues tab that reuses the pull request list, detail and timeline.
- Start a thread from an issue, with the issue as the first message’s context.

## Done when

A project with a GitHub remote lists its issues, filters them, and opens one with its comments.`

/** `github.issue.detail`: #217 has a description, comments and two pull requests; the others a short description and one comment. */
export function issueDetail(now: string, number: number): IssueDetailResult {
  const issue = allIssues(now).find(i => i.number === number) ?? allIssues(now)[0]!
  if (number !== 217) return { issue, body: `Details of “${issue.title}”.`, comments: [{ id: `c-${number}`, author: 'arifw', body: 'I can reproduce this.', created_at: hours(now, 30), url: `${issue.url}#issuecomment-1` }], comment_count: 1 }
  return {
    issue, body: BODY, comment_count: 2,
    comments: [
      { id: 'c1', author: 'arifw', body: 'Could the list keep the same keyboard shortcuts as pull requests? ↑ ↓ to move and Enter to open would be enough for triage.', created_at: hours(now, 48), url: `${issue.url}#issuecomment-1` },
      { id: 'c2', author: 'tresnanda', body: 'Yes — same rows and keys as pull requests. Commenting and closing come in a later release.', created_at: hours(now, 5), url: `${issue.url}#issuecomment-2` },
    ],
    pull_requests: [
      { number: 250, title: 'GitHub issues page', url: 'https://github.com/acme/api/pull/250', state: 'OPEN' },
      { number: 226, title: 'Plain errors for gh', url: 'https://github.com/acme/api/pull/226', state: 'MERGED' },
    ],
  }
}
