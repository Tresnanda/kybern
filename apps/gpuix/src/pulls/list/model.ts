// Pure logic of the pull request list column: readiness groups, the project / repository scope and its per-group memory.
// No React and no theme, so it is unit-tested directly (`model.test.ts`).
import { READINESS_GROUPS, readinessGroup, type ReadinessGroup } from '../../../../../packages/kybern-client/src/pullRequests.ts'
import type { Project, PullRequest } from '../../../../../packages/kybern-client/src/types.ts'

export interface Row { project: Project; pr: PullRequest }

/** Which pull requests the list shows: every project, one project, or some repositories of a group project. */
export interface Scope {
  project: string | null
  /** Member paths of a group project. Empty means the whole project (every repository). */
  repos: string[]
}
export const ALL_PROJECTS: Scope = { project: null, repos: [] }

/** A group project has pull requests in its member repositories, whatever its own folder is. */
export const hasPullRequests = (p: Project) => p.is_git || p.kind === 'group'
export const isGroup = (p: Project) => p.kind === 'group'
/** Members that can list pull requests (a folder that is gone or no longer a repository cannot). */
export const listableMembers = (p: Project) => (p.members ?? []).filter(m => m.status === 'ok')
export const memberName = (project: Project, repo: string | undefined) => repo ? project.members?.find(m => m.path === repo)?.name ?? repo : undefined

/** Projects whose pull requests the scope loads. */
export function scopeTargets(projects: readonly Project[], scope: Scope): Project[] {
  return projects.filter(p => hasPullRequests(p) && (!scope.project || p.id === scope.project))
}

/** A row passes when the scope names no repositories, or names the row's repository. */
export function inScope(row: Row, scope: Scope): boolean {
  if (!scope.project || !scope.repos.length) return true
  return row.project.id === scope.project && !!row.pr.repo && scope.repos.includes(row.pr.repo)
}

export interface ListGroup { group: ReadinessGroup | null; label: string; rows: Row[] }

/**
 * Rows by readiness, in the order of `READINESS_GROUPS`; empty groups are left out. Merged and closed pull requests
 * have no readiness: they come last as one group without a label, in the order given (newest activity first).
 */
export function groupRows(rows: readonly Row[]): ListGroup[] {
  const by = new Map<ReadinessGroup | null, Row[]>()
  for (const row of rows) {
    const key = readinessGroup(row.pr)
    const list = by.get(key)
    if (list) list.push(row)
    else by.set(key, [row])
  }
  const groups: ListGroup[] = READINESS_GROUPS.flatMap(g => by.has(g.value) ? [{ group: g.value, label: g.label, rows: by.get(g.value)! }] : [])
  // Merged and closed rows (the All filter) follow the open groups under their own heading.
  if (by.has(null)) groups.push({ group: null, label: groups.length ? 'Merged and closed' : '', rows: by.get(null)! })
  return groups
}

/** Choosing a project in the filter menu; a group project restores the repositories remembered for it. */
export function pickProject(project: Project | null, remembered: readonly string[] = []): Scope {
  if (!project) return ALL_PROJECTS
  return { project: project.id, repos: isGroup(project) ? validRepos(project, remembered) : [] }
}

/**
 * Ticking a repository of a group project in the menu. From the whole group (or another project) it narrows to just
 * that repository; inside a subset it toggles, and a subset that empties or holds every repository is the whole group.
 */
export function toggleRepo(scope: Scope, project: Project, repo: string): Scope {
  if (scope.project !== project.id || !scope.repos.length) return { project: project.id, repos: [repo] }
  const all = listableMembers(project).map(m => m.path)
  const next = scope.repos.includes(repo) ? scope.repos.filter(r => r !== repo) : all.filter(r => r === repo || scope.repos.includes(r))
  return { project: project.id, repos: next.length === 0 || next.length === all.length ? [] : next }
}

/** One click on a repository chip: only that repository, or `null` for "All". */
export function chooseRepo(project: Project, repo: string | null): Scope {
  return { project: project.id, repos: repo ? [repo] : [] }
}

/** The remembered repositories that still exist in the group; all of them when none do. */
export function validRepos(project: Project, repos: readonly string[]): string[] {
  const all = listableMembers(project).map(m => m.path)
  const kept = repos.filter(r => all.includes(r))
  return kept.length === all.length ? [] : kept
}

export const REPO_MEMORY_LIMIT = 50
/** `group id → repositories`, remembered across launches; the oldest entry goes past `REPO_MEMORY_LIMIT`. */
export type RepoMemory = Record<string, string[]>

export function rememberRepos(memory: RepoMemory, groupId: string, repos: readonly string[]): RepoMemory {
  const next: RepoMemory = { ...memory }
  // Re-inserting moves the group to the newest position.
  delete next[groupId]
  if (repos.length) next[groupId] = [...repos]
  const keys = Object.keys(next)
  for (const key of keys.slice(0, Math.max(0, keys.length - REPO_MEMORY_LIMIT))) delete next[key]
  return next
}

/** Read what a previous version or a hand edit may have left: only string arrays of strings survive. */
export function readRepoMemory(value: unknown): RepoMemory {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: RepoMemory = {}
  for (const [key, repos] of Object.entries(value)) {
    if (Array.isArray(repos) && repos.every(r => typeof r === 'string')) out[key] = repos.slice(0, 64)
  }
  return out
}

/** A stable hue (0-359) for a repository's dot: the same name gets the same colour in every list. */
export function repoHue(key: string): number {
  let hash = 0
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0
  return (hash * 47) % 360
}
