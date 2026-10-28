// The Changes tab of a group thread (L3 sheet 6A/B): one header per repository with its branch and totals, its files
// under it, and repositories without changes still listed ("No changes") so the user sees what the chat spans. A second
// repository's edits are never hidden: headers start open, and only the user collapses one (the chevron turns, 250 ms).
// Repositories keep a fixed order (primary first, then by path), so nothing jumps while the agent edits.
import { memo, useState, type ReactNode } from 'react'
import { GROUP_COPY, groupFilesByRepo, includedMembers, prResultToast, stripRepoPrefix, type MemberLike, type RepoFileGroup } from '../../../../packages/kybern-client/src/groups.ts'
import type { Diff, FileChange, GitStatus, Thread, ThreadMember } from '../../../../packages/kybern-client/src/types.ts'
import { Chevron } from '../motion/Chevron.tsx'
import { Icon } from '../icons.tsx'
import { N } from '../nav/glyphs.ts'
import { errorText } from '../nav/actions.ts'
import { toast } from '../shell/toasts.tsx'
import { threadClient } from '../state.ts'
import { Label, useTheme } from '../ui.tsx'
import { dirtyTotals, prPlan, repoRows, type RepoRow } from '../groups/git.ts'
import { remoteSlug, remoteWebUrl } from '../groups/model.ts'
import { openWeb } from './Diff.tsx'

export type GroupDiffRow = { kind: 'repo'; group: RepoFileGroup<ThreadMember | MemberLike>; open: boolean } | { kind: 'file'; file: FileChange; repo: string }

/** The flat rows of the grouped list (headers, then the files of open headers) for a virtual list. */
export function groupDiffRows(diff: Pick<Diff, 'files'>, members: readonly ThreadMember[], collapsed: ReadonlySet<string>): GroupDiffRow[] {
  const rows: GroupDiffRow[] = []
  for (const group of groupFilesByRepo(diff, includedMembers(members))) {
    const open = !collapsed.has(group.repo.path)
    rows.push({ kind: 'repo', group, open })
    if (open) for (const file of group.files) rows.push({ kind: 'file', file, repo: group.repo.path })
  }
  return rows
}

export function useCollapsedRepos() {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const toggle = (repo: string) => setCollapsed((prev) => {
    const next = new Set(prev)
    if (next.has(repo)) next.delete(repo)
    else next.add(repo)
    return next
  })
  return { collapsed, toggle }
}

/** A repository's header: chevron, glyph, name, branch, totals; "No changes" for a quiet one. */
export const RepoHeader = memo(function RepoHeader({ group, open, branch, onToggle }: { group: RepoFileGroup<ThreadMember | MemberLike>; open: boolean; branch: string | null; onToggle: () => void }) {
  const t = useTheme()
  const empty = group.files.length === 0
  return (
    <div
      testId={`dock-repo-${group.repo.path || 'other'}`}
      role={empty ? undefined : 'button'}
      aria-expanded={empty ? undefined : open}
      tabIndex={empty ? -1 : 0}
      onClick={empty ? undefined : onToggle}
      onKeyDown={(e) => { if (!empty && (e.key === 'enter' || e.key === 'space')) onToggle() }}
      style={{ display: 'flex', alignItems: 'center', gap: 6, height: 30, marginTop: 4, marginLeft: 6, marginRight: 6, paddingLeft: 4, paddingRight: 8, borderRadius: 6, cursor: empty ? 'default' : 'pointer', ...(empty ? {} : { hover: { backgroundColor: t.buttonSecondaryHover } }) }}
    >
      <div style={{ display: 'flex', width: 14, height: 14, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        {!empty && <Chevron open={open} color={t.textTertiary} />}
      </div>
      <Icon source={N.repo} size={14} color={empty ? t.textTertiary : t.textSecondary} />
      <Label color={empty ? t.textSecondary : t.text} size={13} weight={600} truncate style={{ flexShrink: 0, maxWidth: '40%' }}>{group.repo.name}</Label>
      {branch && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 3, minWidth: 0, flexShrink: 1 }}>
          <Icon source={N.branch} size={11} color={t.textTertiary} />
          <Label color={t.textTertiary} size={12} truncate>{branch}</Label>
        </div>
      )}
      <div style={{ flexGrow: 1 }} />
      {empty ? (
        <Label color={t.textTertiary} size={11}>{GROUP_COPY.noChanges}</Label>
      ) : (
        <>
          {group.additions > 0 && <Label color={t.green} size={11}>{`+${group.additions}`}</Label>}
          {group.deletions > 0 && <Label color={t.red} size={11}>{`−${group.deletions}`}</Label>}
          <Label color={t.textTertiary} size={11}>{`${group.files.length} ${group.files.length === 1 ? 'file' : 'files'}`}</Label>
        </>
      )}
    </div>
  )
})

/** The header's branch: the chat's worktree branch, or (local) that repository's own checkout branch. */
export function repoBranch(thread: Thread, git: GitStatus | null, repo: string): string | null {
  const member = thread.members?.find((m) => m.path === repo)
  return member?.worktree?.branch ?? git?.repos?.find((r) => r.repo === repo)?.branch ?? member?.base_branch ?? null
}

/** A file under its repository's header: the name, then its folder inside that repository. */
export function fileParts(file: FileChange, repo: string): { name: string; folder: string } {
  const inner = stripRepoPrefix(file.path, repo)
  const name = inner.split('/').pop() ?? inner
  return { name, folder: inner.slice(0, Math.max(0, inner.length - name.length - 1)) }
}

/** The environment rows a group thread adds to the dock's Changes tab (sheet 6C–E): repositories, then pull requests. */
export function GroupEnvironmentRows({ thread, diff, git, row, divider, title, onChanged }: {
  thread: Thread
  diff: Diff | null
  git: GitStatus | null
  /** The pane's own row component, so both surfaces keep their look. */
  row: (props: { key?: string; icon: string; label: string; trailing?: ReactNode; detail?: string; onClick?: () => void; disabled?: boolean; testId?: string; busy?: boolean }) => ReactNode
  divider: ReactNode
  title: (text: string) => ReactNode
  onChanged: () => void
}) {
  const t = useTheme()
  const [busy, setBusy] = useState(false)
  const rows = repoRows(thread.members ?? [], diff, git)
  const plan = prPlan(rows)
  const create = async () => {
    const client = threadClient(thread.id)
    if (!client || busy || !plan) return
    setBusy(true)
    try {
      const result = await client.call('github.pr.create_group', { thread_id: thread.id, repos: plan.repos })
      if (threadClient(thread.id) !== client) return
      const first = result.pull_requests[0]?.pull_request
      toast(prResultToast(result.pull_requests.length, result.skipped ?? []), first ? { action: { label: GROUP_COPY.outsideChangeOpen, onClick: () => openWeb(first.url) } } : undefined)
      onChanged()
    } catch (e) {
      if (threadClient(thread.id) === client) toast.error('Unable to create pull requests', { description: errorText(e) })
    } finally { setBusy(false) }
  }
  const prs = rows.filter((r) => r.git?.pull_request)
  // As for one repository: no checkout to read (the worktree was removed, or git is still loading), no remote or pull request rows.
  if (!rows.some((r) => r.git?.is_git)) return null
  return (
    <>
      {divider}
      {title(GROUP_COPY.repositories)}
      {rows.map((r) => <RemoteRow key={r.member.path} r={r} row={row} />)}
      {divider}
      {title(GROUP_COPY.pullRequests)}
      {prs.map((r) => {
        const pr = r.git!.pull_request!
        return row({ key: `pr:${r.member.path}`, icon: N.pullRequest, label: `${r.member.name} #${pr.number} ${pr.title}`, onClick: () => openWeb(pr.url), testId: `group-pr-${r.member.path}`, trailing: <Label color={t.textSecondary} size={11}>{pr.is_draft ? 'Draft' : 'Open'}</Label> })
      })}
      {plan && row({ key: 'create', icon: N.pullRequest, label: busy ? 'Creating…' : plan.label, onClick: () => void create(), disabled: busy || !plan.repos.length, busy, testId: 'group-create-prs', detail: plan.caption })}
      {!plan && !prs.length && <Label color={t.textTertiary} size={12} lineHeight={17} style={{ paddingLeft: 8, paddingRight: 8, paddingBottom: 4 }}>{GROUP_COPY.noChanges}</Label>}
    </>
  )
}

function RemoteRow({ r, row }: { r: RepoRow; row: Parameters<typeof GroupEnvironmentRows>[0]['row'] }) {
  const t = useTheme()
  const web = remoteWebUrl(r.git?.remote_url)
  // A remote without a web page (a local path, a bare server) is named by the repository, and only a missing one says so.
  const slug = web ? remoteSlug(r.git?.remote_url) : null
  const ahead = r.git?.ahead ? `↑${r.git.ahead}` : ''
  return row({
    key: r.member.path,
    icon: N.repo,
    label: slug ?? r.member.name,
    onClick: web ? () => openWeb(web) : undefined,
    testId: `group-remote-${r.member.path}`,
    trailing: <>
      {ahead && <Label color={t.textSecondary} size={12}>{ahead}</Label>}
      {web ? <Icon source={N.external} size={13} color={t.textSecondary} /> : !r.git?.remote_url && <Label color={t.textTertiary} size={12}>{GROUP_COPY.noRemote}</Label>}
    </>,
  })
}

/** Commit-and-push detail for a group: "6 in 2 repos". */
export function groupDirty(thread: Thread, diff: Diff | null, git: GitStatus | null) {
  return dirtyTotals(repoRows(thread.members ?? [], diff, git))
}
