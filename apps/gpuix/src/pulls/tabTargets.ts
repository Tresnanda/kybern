// Repository-qualified PR targets. Only projects already in the merged network list can be opened.
import type { Project, PullRequest } from '../../../../packages/kybern-client/src/types.ts'
export interface PrTarget { projectId: string; number: number; repo?: string; title?: string }
export interface KnownRepo { projectId: string; repo?: string; remote: string }
export function githubRepo(value: string | null | undefined): string | null {
  if (!value) return null
  const clean = value.trim().replace(/\.git\/?$/, '').replace(/\/$/, '')
  const m = /^(?:(?:https?:\/\/|ssh:\/\/)(?:[^/@]+@)?github\.com[/:]|git@github\.com:|github\.com\/)([^/]+\/[^/]+)$/i.exec(clean)
  return m ? m[1]!.toLowerCase() : null
}
export function githubPull(value: string): { remote: string; number: number } | null {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9]\d*)(?:[/?#].*)?$/i.exec(value.trim())
  const number = m ? Number(m[2]) : 0
  return m && Number.isSafeInteger(number) ? { remote: m[1]!.toLowerCase(), number } : null
}
/** A GitHub issue link (`/issues/N`, with a query, a fragment such as `#issuecomment-1`, or a trailing slash). */
export function githubIssue(value: string): { remote: string; number: number } | null {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/([1-9]\d*)\/?(?:[?#].*)?$/i.exec(value.trim())
  const number = m ? Number(m[2]) : 0
  return m && Number.isSafeInteger(number) ? { remote: m[1]!.toLowerCase(), number } : null
}
/** A GitHub Actions run or job link. A check-run link (`/runs/<id>`) names a job only: for Actions the check run's id is the job's. */
export interface ActionsLink { remote: string; runId?: number; jobId?: number; attempt?: number }
const positive = (value: string | undefined) => { const n = Number(value); return Number.isSafeInteger(n) && n > 0 ? n : undefined }
export function githubActions(value: string): ActionsLink | null {
  const url = /^https:\/\/github\.com\/([^/?#]+\/[^/?#]+)\/(.*)$/i.exec(value.trim())
  if (!url) return null
  const remote = url[1]!.toLowerCase()
  const path = url[2]!.replace(/[?#].*$/, '').replace(/\/$/, '')
  const check = /^runs\/([1-9]\d*)$/.exec(path)
  if (check) { const jobId = positive(check[1]); return jobId ? { remote, jobId } : null }
  const run = /^actions\/runs\/([1-9]\d*)(?:\/attempts\/([1-9]\d*))?(?:\/job\/([1-9]\d*))?$/.exec(path)
  const runId = positive(run?.[1])
  if (!run || !runId) return null
  const attempt = positive(run[2]), jobId = positive(run[3])
  return { remote, runId, ...(jobId ? { jobId } : {}), ...(attempt ? { attempt } : {}) }
}
/** Where an Actions link opens: the project (and group member) that owns the repository, and what to show of it. */
export interface ActionsTarget { projectId: string; repo?: string; runId?: number; jobId?: number; attempt?: number }
export function resolveActions(value: string, repos: readonly KnownRepo[]): ActionsTarget | null {
  const link = githubActions(value)
  const known = link && repos.find(r => r.remote === link.remote)
  if (!link || !known) return null
  const { remote: _, ...rest } = link
  return { projectId: known.projectId, ...(known.repo ? { repo: known.repo } : {}), ...rest }
}
/** Where an issue link opens: the project (and group member) that owns the repository, and the issue. */
export interface IssueTarget { projectId: string; number: number; repo?: string }
export function resolveIssue(value: string, repos: readonly KnownRepo[]): IssueTarget | null {
  const issue = githubIssue(value)
  const known = issue && repos.find(r => r.remote === issue.remote)
  return known && issue ? { projectId: known.projectId, number: issue.number, ...(known.repo ? { repo: known.repo } : {}) } : null
}
export function resolvePull(value: string, repos: readonly KnownRepo[]): PrTarget | null {
  const pull = githubPull(value)
  const known = pull && repos.find(r => r.remote === pull.remote)
  return known && pull ? { projectId: known.projectId, number: pull.number, ...(known.repo ? { repo: known.repo } : {}) } : null
}
export const targetOf = (project: Project, pr: PullRequest): PrTarget => ({ projectId: project.id, number: pr.number, title: pr.title, ...(pr.repo ? { repo: pr.repo } : {}) })
export function matchingPulls(rows: readonly {project: Project; pr: PullRequest}[], query: string) {
  const q = query.trim().toLowerCase().replace(/^#/, '')
  return rows.filter(({project,pr}) => !q || `${project.name} ${pr.repo ?? ''} ${pr.number} ${pr.title} ${pr.head}`.toLowerCase().includes(q))
}
