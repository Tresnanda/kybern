/** Pull request detail states for the in-memory fixture (`actionFixture({ state })`): one per verdict, with the rich data the page shows. */
import type { PrCheck, PrDetailResult, PrViewer } from '../../../../packages/kybern-client/src/types.ts'

export type PrState = 'running' | 'optional' | 'ready' | 'blocked' | 'behind' | 'failing' | 'conflicts' | 'auto' | 'draft' | 'merged'
export const PR_STATES: PrState[] = ['running', 'optional', 'ready', 'blocked', 'behind', 'failing', 'conflicts', 'auto', 'draft', 'merged']

const BODY = `### Summary

Park \`development\` (5a38d8b45) into \`staging\` (019f5597a). It carries 2 PRs:

- #2858 IG review: neutral content wording in Get New Fans + Privacy 13/14/15 (privacy-policy-2026-10f)
- #2856 docs(specs): PL-01..04 rows describe the state after the launch_config drop

Migrations (1 added, none modified or deleted):

\`\`\`diff
+ 20261028024038_legal_versions_privacy_ig_content_wording.sql   # PR 2858: inserts legal_versions row privacy-policy-2026-10f
\`\`\`

- Edge functions: none changed.
- New secret names: none
- Env vars: none

### To prove on staging after the merge

- Migration 20261028024038 is recorded in \`supabase_migrations.schema_migrations\`.
- \`legal_versions\` has \`privacy-policy-2026-10f\`.`

const viewer: PrViewer = { can_merge: true, can_merge_as_admin: false, can_update_branch: true, can_enable_auto_merge: true, can_disable_auto_merge: true, can_mark_ready: true, merge_methods: ['squash', 'merge', 'rebase'] }
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const MIN = 60_000

const run = (name: string, workflow: string, required: boolean, over: Partial<PrCheck> = {}): PrCheck => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS', url: 'https://example.com/run', workflow_name: workflow, is_required: required, started_at: ago(5 * MIN), completed_at: ago(2 * MIN), ...over })
const running = (name: string, workflow: string, since: number): PrCheck => run(name, workflow, true, { status: 'IN_PROGRESS', conclusion: '', started_at: ago(since), completed_at: undefined })
const skipped = (name: string): PrCheck => run(name, 'Deploy', false, { conclusion: 'SKIPPED', started_at: ago(5 * MIN), completed_at: ago(5 * MIN) })

const runningChecks = (): PrCheck[] => [
  running('🧪 Tests (shard 1/4)', 'CI', 3.2 * MIN), run('🧪 Tests (shard 2/4)', 'CI', true), running('🧪 Tests (shard 3/4)', 'CI', 3.2 * MIN), running('🧪 Tests (shard 4/4)', 'CI', 3.2 * MIN),
  running('🗄️ Local-DB suites (RLS + RPC) (shard 1/2)', 'CI', 2.8 * MIN), running('🗄️ Local-DB suites (RLS + RPC) (shard 2/2)', 'CI', 2.8 * MIN),
  ...['Deploy edge functions', 'Deploy web', 'Preview', 'Lighthouse', 'Notify'].map(skipped),
]
const passedChecks = (): PrCheck[] => [run('Tests', 'CI', true), run('Typecheck', 'CI', true), run('Lint', 'CI', false), run('Build', 'CI', true), skipped('Deploy web')]

const people = { kevin: { login: 'kevin', avatar_url: 'https://invalid.example/kevin.png' }, tres: { login: 'Tresnanda', avatar_url: 'https://invalid.example/tres.png' } }

/** `base` is the fixture's own detail; each state replaces what its verdict reads. */
export function stateDetail(state: PrState, base: PrDetailResult): PrDetailResult {
  const pr = { ...base.pull_request, title: 'development -> staging', head: 'development', base: 'staging', author: 'Tresnanda', author_avatar_url: 'https://invalid.example/tres.png', created_at: ago(8 * MIN), updated_at: ago(2 * MIN), additions: 232, deletions: 53, review_decision: undefined as string | undefined, labels: [{ name: 'release', color: '4285f4' }, { name: 'staging', color: 'a371f7' }] }
  const common = { ...base, body: base.body.length > 1500 ? base.body : BODY, head_sha: 'e9e5375b1c0d2a3f', reviewers: ['kevin'], reviews: [{ ...people.kevin, state: 'REQUESTED' }], assignees: [people.tres], viewer, comment_count: 0, timeline_counts: { comments: 0, reviews: 0, commits: 3 }, merge_state_status: 'UNSTABLE', changed_files: 20 }
  const sum = (checks: PrCheck[]) => ({ total: checks.length, passed: checks.filter(c => c.conclusion === 'SUCCESS').length, failed: checks.filter(c => c.conclusion === 'FAILURE').length, pending: checks.filter(c => c.status !== 'COMPLETED').length, skipped: checks.filter(c => c.conclusion === 'SKIPPED').length })
  const make = (checks: PrCheck[], over: Partial<PrDetailResult>, prOver: Record<string, unknown> = {}): PrDetailResult => ({ ...common, checks, ...over, pull_request: { ...pr, checks_summary: sum(checks), ...prOver } })
  switch (state) {
    // Required checks running: GitHub reports BLOCKED and auto-merge can wait for them.
    case 'running': return make(runningChecks(), { merge_state_status: 'BLOCKED' })
    // Nothing running is required: GitHub reports UNSTABLE and could merge now, so there is no auto-merge.
    case 'optional': return make(runningChecks().map(c => ({ ...c, is_required: false })), {})
    case 'ready': return make(passedChecks(), { merge_state_status: 'CLEAN', reviews: [{ ...people.kevin, state: 'APPROVED' }], reviewers: [], comment_count: 4 }, { review_decision: 'APPROVED', mergeable: 'MERGEABLE' })
    case 'blocked': return make(passedChecks(), { merge_state_status: 'BLOCKED', viewer: { ...viewer, can_merge_as_admin: true }, reviews: [{ ...people.kevin, state: 'REQUESTED' }] }, { review_decision: 'REVIEW_REQUIRED' })
    case 'behind': return make(passedChecks(), { merge_state_status: 'BEHIND', behind_by: 3, reviews: [{ ...people.kevin, state: 'APPROVED' }], reviewers: [] }, { review_decision: 'APPROVED' })
    case 'failing': return make([run('Tests (shard 1/4)', 'CI', true), run('Tests (shard 2/4)', 'CI', true), run('Tests (shard 3/4)', 'CI', true, { conclusion: 'FAILURE' }), run('Tests (shard 4/4)', 'CI', true), run('Lint', 'CI', false), skipped('Deploy web')], { merge_state_status: 'BEHIND', behind_by: 3, reviews: [{ ...people.kevin, state: 'CHANGES_REQUESTED' }], reviewers: [], comment_count: 6 }, { review_decision: 'CHANGES_REQUESTED' })
    case 'conflicts': return make(passedChecks(), { merge_state_status: 'DIRTY', reviews: [{ ...people.kevin, state: 'APPROVED' }], reviewers: [] }, { mergeable: 'CONFLICTING', review_decision: 'APPROVED' })
    case 'auto': return make(runningChecks(), { merge_state_status: 'BLOCKED' }, { auto_merge: { enabled_by: 'Tresnanda', merge_method: 'squash' } })
    case 'draft': return make([], { merge_state_status: 'DRAFT', reviews: [], reviewers: [] }, { is_draft: true })
    case 'merged': return make(passedChecks(), { merged_at: ago(3 * MIN), merged_by: 'kevin', merge_state_status: 'UNKNOWN', reviews: [{ ...people.kevin, state: 'APPROVED' }], reviewers: [] }, { state: 'MERGED', review_decision: 'APPROVED' })
  }
}
