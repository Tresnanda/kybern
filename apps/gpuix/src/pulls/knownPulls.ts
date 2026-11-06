import { classifyPrError } from '@/state/prReviewModel'
import { errorMessage } from '../../../../packages/kybern-client/src/problem.ts'
import { describeProblem } from '../../../../packages/kybern-client/src/problems.ts'
import { mapWithConcurrency } from '@/lib/workload'
import type { Project } from '../../../../packages/kybern-client/src/types.ts'
import type { prCall } from './client.ts'
import { hasPullRequests, type Row } from './list/model.ts'
import { githubActions, githubIssue, githubPull, githubRepo, resolveActions, type ActionsTarget, type IssueTarget, type KnownRepo, type PrTarget } from './tabTargets.ts'

/** All known network projects, independently of the active Space. Partial failures keep usable results. */
export async function loadKnownPulls(projects: readonly Project[], call: typeof prCall) {
  const loaded = await mapWithConcurrency(projects.filter(hasPullRequests), 3, async project => {
    const repos: KnownRepo[] = []
    const rows: Row[] = []
    const errors: string[] = []
    const add = (remote: string | null | undefined, repo?: string) => {
      const identity = githubRepo(remote)
      if (identity) repos.push({ projectId: project.id, ...(repo ? { repo } : {}), remote: identity })
    }
    if (project.kind !== 'group') add(project.repo?.remote)
    const results = await Promise.allSettled([
      call(project.id, 'github.pr.list', { project_id: project.id, state: 'all', limit: 100 }).then(result => {
        for (const pr of result.pull_requests) {
          rows.push({ project, pr })
          const identity = githubPull(pr.url)
          if (identity) add(`github.com/${identity.remote}`, pr.repo)
        }
        for (const member of result.repos ?? []) {
          if (member.error && !member.skipped) errors.push(`${project.name} / ${member.name}: ${member.error}`)
        }
      }),
      ...(project.kind === 'group' ? [call(project.id, 'projects.members.status', { project_id: project.id }).then(result => {
        for (const member of result.members) if (member.status === 'ok') add(member.remote_url, member.path)
      })] : []),
    ])
    for (const result of results) {
      if (result.status !== 'rejected' || classifyPrError(errorMessage(result.reason)) === 'no-remote') continue
      // The headline only ("Install GitHub CLI to load pull requests"): the raw text never reaches the page.
      errors.push(`${project.name}: ${describeProblem(result.reason, { action: 'load pull requests' }).title}`)
    }
    return { repos, rows, errors }
  })
  return { repos: loaded.flatMap(r => r.repos), rows: loaded.flatMap(r => r.rows), errors: loaded.flatMap(r => r.errors) }
}

/** A repository identity usually resolves from the projects' own remotes without listing GitHub PRs across the network. */
export async function resolveKnownRepo(remote: string, projects: readonly Project[], call: typeof prCall): Promise<KnownRepo | null> {
  const direct = projects.find(project => project.kind !== 'group' && githubRepo(project.repo?.remote) === remote)
  if (direct) return { projectId: direct.id, remote }
  const groups = projects.filter(project => project.kind === 'group' && [project.repo, ...(project.repos ?? [])].some(repo => githubRepo(repo?.remote) === remote))
  if (groups.length) {
    const found = await mapWithConcurrency(groups, 3, async project => {
      try {
        const result = await call(project.id, 'projects.members.status', { project_id: project.id })
        return result.members.flatMap(member => member.status === 'ok' && githubRepo(member.remote_url) === remote ? [{ projectId: project.id, repo: member.path, remote }] : [])
      } catch { return [] }
    })
    return found.flat()[0] ?? null
  }
  // Older daemons may not have populated project identities yet. Listed URLs and member remotes remain registered targets.
  return (await loadKnownPulls(projects, call)).repos.find(repo => repo.remote === remote) ?? null
}

/** A transcript URL resolves to its owning project like the picker's known network does. */
export async function resolveKnownPull(url: string, projects: readonly Project[], call: typeof prCall): Promise<PrTarget | null> {
  const pull = githubPull(url)
  const known = pull && await resolveKnownRepo(pull.remote, projects, call)
  return known && pull ? { projectId: known.projectId, number: pull.number, ...(known.repo ? { repo: known.repo } : {}) } : null
}

/** An Actions target with its run: a check-run link names only a job, and the daemon says which run it belongs to. */
export async function completeRun(target: ActionsTarget, call: typeof prCall): Promise<ActionsTarget | null> {
  if (target.runId) return target
  if (!target.jobId) return null
  try {
    const result = await call(target.projectId, 'github.actions.run', { project_id: target.projectId, ...(target.repo ? { repo: target.repo } : {}), job_id: target.jobId })
    return { ...target, runId: result.run.id }
  } catch { return null }
}

/** A GitHub Actions link for a known repository, ready for the Actions tab. */
export async function resolveKnownRun(url: string, projects: readonly Project[], call: typeof prCall): Promise<ActionsTarget | null> {
  const link = githubActions(url)
  const known = link && await resolveKnownRepo(link.remote, projects, call)
  const target = known && resolveActions(url, [known])
  return target ? completeRun(target, call) : null
}

/** An issue link of a known repository, ready for the Issues tab; unknown repositories stay with the browser. */
export async function resolveKnownIssue(url: string, projects: readonly Project[], call: typeof prCall): Promise<IssueTarget | null> {
  const issue = githubIssue(url)
  const known = issue && await resolveKnownRepo(issue.remote, projects, call)
  return known && issue ? { projectId: known.projectId, number: issue.number, ...(known.repo ? { repo: known.repo } : {}) } : null
}
