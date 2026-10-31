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
