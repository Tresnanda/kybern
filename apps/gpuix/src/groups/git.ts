// What a group thread's git surfaces say (L3 sheet 6): which repositories changed, which can get a pull request, and the
// per-repository rows of the environment card. Pure: `DiffPane` and the environment panel both read it.
import { includedMembers, prButtonLabel, prCaption } from '../../../../packages/kybern-client/src/groups.ts'
import type { Diff, GitStatus, RepoGitStatus, ThreadMember } from '../../../../packages/kybern-client/src/types.ts'

export interface RepoRow {
  member: ThreadMember
  git: RepoGitStatus | undefined
  /** Files this chat changed in the repository. */
  files: number
}

/** One row per member the chat uses, in project order, with its git state and changed-file count. */
export function repoRows(members: readonly ThreadMember[], diff: Pick<Diff, 'files' | 'repos'> | null, git: Pick<GitStatus, 'repos'> | null): RepoRow[] {
  return includedMembers(members).map((member) => ({
    member,
    git: git?.repos?.find((r) => r.repo === member.path),
    files: diff?.repos?.find((r) => r.repo === member.path)?.files ?? diff?.files.filter((f) => f.repo === member.path).length ?? 0,
  }))
}

export interface PrPlan {
  /** Repositories that will get a pull request. */
  repos: string[]
  label: string
  caption: string
}

/** "Create 2 pull requests": changed repositories with a remote and no open pull request; the caption names the rest. */
export function prPlan(rows: readonly RepoRow[]): PrPlan | null {
  const open = rows.filter((r) => r.git?.pull_request)
  const changed = rows.filter((r) => r.files > 0 && !r.git?.pull_request)
  const ready = changed.filter((r) => !!r.git?.remote_url)
  const noRemote = changed.filter((r) => !r.git?.remote_url)
  if (!changed.length) return null
  const unchanged = rows.filter((r) => r.files === 0 && !open.includes(r))
  return {
    repos: ready.map((r) => r.member.path),
    label: prButtonLabel(Math.max(1, ready.length)),
    caption: prCaption(ready.map((r) => r.member.name), unchanged.map((r) => r.member.name), noRemote.map((r) => r.member.name)),
  }
}

/** Uncommitted files across the chat's repositories, and how many repositories hold them. */
export function dirtyTotals(rows: readonly RepoRow[]): { files: number; repos: number } {
  const dirty = rows.filter((r) => (r.git?.dirty_files ?? 0) > 0)
  return { files: dirty.reduce((n, r) => n + (r.git?.dirty_files ?? 0), 0), repos: dirty.length }
}
