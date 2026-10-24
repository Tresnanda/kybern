// Pure helpers for the group sheets: paths as the user sees them, the checklist selection, and which candidates a group
// can still take. Copy and member rules are in `packages/kybern-client/src/groups.ts`.
import { GROUP_FOLDER_MEMBER, orderMemberPaths } from '../../../../packages/kybern-client/src/groups.ts'
import type { CopyCandidate, RepoCandidate } from '../../../../packages/kybern-client/src/types.ts'

/** `/Users/me/work/acme` → `~/work/acme`. */
export function tildify(path: string, home: string): string {
  if (!home) return path
  const root = home.endsWith('/') ? home.slice(0, -1) : home
  return path === root ? '~' : path.startsWith(`${root}/`) ? `~${path.slice(root.length)}` : path
}

/** The last path component (the group folder's name in copy such as "Pick a folder inside acme"). */
export function folderName(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed
}

/** `picked` relative to `folder` ('/'-separated, "." for the folder itself), or null when it is outside. */
export function relativeInside(folder: string, picked: string): string | null {
  const root = folder.replace(/\/+$/, '')
  const path = picked.replace(/\/+$/, '')
  if (path === root) return GROUP_FOLDER_MEMBER
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null
}

/** A deeper repository shows its relative path next to its name (`billing  services/billing`). */
export function candidatePathHint(candidate: Pick<RepoCandidate, 'path' | 'name'>): string | null {
  return candidate.path !== GROUP_FOLDER_MEMBER && candidate.path !== candidate.name ? candidate.path : null
}

/** Submodules are listed but belong to their parent repository. */
export const isSelectable = (candidate: Pick<RepoCandidate, 'submodule_of'>) => !candidate.submodule_of

/** Tick or untick one path; the result keeps the daemon's member order. */
export function toggled(selected: readonly string[], path: string): string[] {
  return selected.includes(path) ? selected.filter((p) => p !== path) : orderMemberPaths([...selected, path])
}

/** Candidates in display order: the group folder first, then by path (the scan's own order, kept stable for added rows). */
export function orderCandidates(candidates: readonly RepoCandidate[]): RepoCandidate[] {
  const order = orderMemberPaths(candidates.map((c) => c.path))
  return order.map((path) => candidates.find((c) => c.path === path)!)
}

/** Merge a rescan (with `include`) into the rows already shown: new ones are appended in order and marked `added`. */
export function mergeCandidates(shown: readonly RepoCandidate[], next: readonly RepoCandidate[], included: readonly string[]): RepoCandidate[] {
  const known = new Set(shown.map((c) => c.path))
  const fresh = next.filter((c) => !known.has(c.path)).map((c) => (included.includes(c.path) ? { ...c, added: true } : c))
  return orderCandidates([...shown, ...fresh])
}

/** Candidates the Repositories dialog's "Add repositories…" offers: repositories not in the group yet. */
export function nonMembers(candidates: readonly RepoCandidate[], members: readonly string[]): RepoCandidate[] {
  return candidates.filter((c) => !members.includes(c.path))
}

/** Top-level entries "Also copy into worktrees" can still offer: not chosen yet, not a member, not `.git`. */
export function copyChoices(candidates: readonly CopyCandidate[], chosen: readonly string[], members: readonly string[]): CopyCandidate[] {
  return candidates.filter((c) => c.name !== '.git' && !chosen.includes(c.name) && !members.includes(c.name))
}

/** `git@github.com:acme/api.git` or `https://github.com/acme/api` → `acme/api`; null when it is not owner/name shaped. */
export function remoteSlug(url: string | null | undefined): string | null {
  if (!url) return null
  return /[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(url)?.[1] ?? null
}

/** Whether `gh` can open a pull request for this remote: the daemon skips anything not on github.com (`has_github_remote`). */
export const isGithubRemote = (url: string | null | undefined): boolean => !!url && url.includes('github.com')

/** The web page of a remote (`git@host:owner/name.git` → `https://host/owner/name`), or null for anything else. */
export function remoteWebUrl(url: string | null | undefined): string | null {
  if (!url) return null
  const web = url.replace(/^git@([^:]+):/, 'https://$1/').replace(/\.git$/, '')
  return /^https?:\/\//.test(web) ? web : null
}
