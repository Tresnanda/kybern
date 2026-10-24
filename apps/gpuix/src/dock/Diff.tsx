import { DOCK_ICONS } from './icons.ts'
import { spawn } from 'node:child_process'
import { memo, useCallback, useEffect, useState, type ReactNode } from 'react'
import type { Diff as ThreadDiff, FileChange, GitStatus, Thread } from '../../../../packages/kybern-client/src/types.ts'
import { Icon } from '../icons.tsx'
import { ISLAND } from '../MatrixLoader.tsx'
import { errorText } from '../nav/actions.ts'
import { N } from '../nav/glyphs.ts'
import { getClient, onOpenEvent, useApp } from '../state.ts'
import { desktopDiffTheme } from '../native/diff.ts'
import { NativeDiffHeader } from '../native/DiffView.tsx'
import { Label, useTheme } from '../ui.tsx'
import { Button } from '../kit/Button.tsx'
import { ErrorLine } from './parts.tsx'
import { openTab } from '../tabs/open.ts'
import { diffFileIcons } from '../native/diff-file-icons.ts'
import { getFileIconName } from '../../../desktop/src/lib/kit/fileIcons.ts'
import { LoadingLines } from './loading.tsx'
import { Spinner } from '../kit/Spinner.tsx'
import { changedReposLabel, commitDetail, includedMembers, isGroupThread, repoBadge } from '../../../../packages/kybern-client/src/groups.ts'
import { fileParts, groupDiffRows, GroupEnvironmentRows, groupDirty, RepoHeader, repoBranch, useCollapsedRepos } from './GroupDiff.tsx'

export function openWeb(url: string) {
  // Only web links from daemon records; never hand arbitrary schemes to macOS.
  if (/^https?:\/\//i.test(url)) spawn('open', [url], { stdio: 'ignore' }).on('error', () => {})
}

/**
 * `list` (the dock's Changes tab): the environment, commit and pull request actions, then one row per changed file that opens
 * its diff as a tab (one click: the preview tab; a double click keeps it). `all` (the Changes tab beside the chat): every file's
 * diff, open. `path`: one file's diff tab.
 */
export function DiffPane({ thread, onStats, mode = 'list', path }: { thread: Thread; onStats?: (adds: number, dels: number) => void; mode?: 'list' | 'all'; path?: string }) {
  const t = useTheme()
  const project = useApp(s => s.projects.find(p => p.id === thread.project_id))
  const [diff, setDiff] = useState<ThreadDiff | null>(null)
  const [git, setGit] = useState<GitStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [generation, setGeneration] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const refresh = useCallback(() => setGeneration((n) => n + 1), [])
  useEffect(() => {
    const client = getClient()
    if (!client) return
    let current = true
    setError(null)
    void client.call('git.status', { thread_id: thread.id }).then(status => { if (current) setGit(status) }, e => { if (current) setError(errorText(e)) })
    void client.call('threads.diff', { thread_id: thread.id, include_patch: false }).then(changes => {
      if (!current) return
      setDiff(changes); setLoaded(true)
      onStats?.(changes.files.reduce((n, f) => n + f.additions, 0), changes.files.reduce((n, f) => n + f.deletions, 0))
    }, e => {
      if (!current) return
      // A new thread has no checkpoint yet; its project still has git status.
      if (!/no checkpoints yet/i.test(errorText(e))) setError(errorText(e))
      setLoaded(true)
    })
    return () => { current = false }
  }, [thread.id, generation, onStats])
  useEffect(() => onOpenEvent((event) => {
    if (event.thread_id === thread.id && (event.kind === 'turn_completed' || event.kind === 'turn_failed')) refresh()
  }), [thread.id, refresh])
  const run = async (kind: 'commit' | 'pr') => {
    if (busy) return
    setBusy(kind); setError(null); setNotice(null)
    try {
      if (kind === 'commit') {
        const result = await getClient()!.call('git.commit', { thread_id: thread.id })
        setNotice(`Committed · ${result.message}`)
      } else {
        const result = await getClient()!.call('github.pr.create', { thread_id: thread.id })
        setNotice(`Pull request opened · #${result.number} ${result.title}`)
      }
      refresh()
    } catch (e) { setError(errorText(e)) } finally { setBusy(null) }
  }
  const files = (diff?.files ?? []).filter((file) => !path || file.path === path)
  // A group thread groups its files under one header per repository (`GroupDiff.tsx`).
  const group = isGroupThread(thread)
  const included = includedMembers(thread.members)
  const { collapsed, toggle } = useCollapsedRepos()
  const rows = group && !path ? groupDiffRows({ files }, thread.members ?? [], collapsed) : null
  const changedRepos = new Set(files.map((f) => f.repo ?? '')).size
  const dirty = group ? groupDirty(thread, diff, git) : { files: 0, repos: 0 }
  return <>
    {mode === 'list' && <>
    <div {...ISLAND} style={{ display: 'flex', flexDirection: 'column', width: '100%', gap: 2, padding: 6, flexShrink: 0 }}>
      <Label color={t.textSecondary} size={14} lineHeight={21} style={{ paddingLeft: 8, paddingTop: 2, paddingBottom: 2, opacity: 0.4 }}>Environment</Label>
      <EnvironmentRow icon={group ? (thread.worktree ? N.worktree : N.folders) : N.laptop} label={project?.name ?? 'Local'} trailing={group ? repoBadge(included.length) : 'Local'} />
      {group && <>
        <EnvironmentRow icon={N.branch} label={thread.worktree?.branch ?? git?.branch ?? 'detached'} trailing={`in ${repoBadge(included.length)}`} />
        <EnvironmentRow icon={DOCK_ICONS.commit} label={busy === 'commit' ? 'Committing…' : 'Commit and push'} disabled={!!busy || dirty.files === 0} onClick={() => void run('commit')} testId="dock-commit" trailing={dirty.files ? commitDetail(dirty.files, dirty.repos) : undefined} />
        <GroupEnvironmentRows
          thread={thread}
          diff={diff}
          git={git}
          onChanged={refresh}
          divider={<div style={{ height: 1, marginTop: 4, marginBottom: 4, backgroundColor: t.borderLight }} />}
          title={(text) => <Label color={t.textSecondary} size={13} lineHeight={19.5} style={{ paddingLeft: 8, paddingTop: 4, paddingBottom: 4, opacity: 0.4 }}>{text}</Label>}
          row={({ key, ...props }) => <EnvironmentRow key={key} {...props} />}
        />
      </>}
      {git?.is_git && !group && <>
        <EnvironmentRow icon={N.branch} label={git.branch ?? 'detached'} trailing={`${git.ahead ? `↑${git.ahead}` : ''}${git.behind ? ` ↓${git.behind}` : ''}`} />
        <EnvironmentRow icon={DOCK_ICONS.commit} label={busy === 'commit' ? 'Committing…' : 'Commit and push'} disabled={!!busy || git.dirty_files === 0} onClick={() => void run('commit')} testId="dock-commit" trailing={git.dirty_files ? String(git.dirty_files) : undefined} />
        {git.remote_url && <>
          <div style={{ height: 1, marginTop: 4, marginBottom: 4, backgroundColor: t.borderLight }} />
          <Label color={t.textSecondary} size={13} lineHeight={19.5} style={{ paddingLeft: 8, paddingTop: 4, paddingBottom: 4, opacity: 0.4 }}>Repository</Label>
          <EnvironmentRow icon={N.branch} label={git.remote_url.replace(/.*[:/](.*?\/[^/]+?)(?:\.git)?$/, '$1')} onClick={() => openWeb(git.remote_url!.replace(/^git@([^:]+):/, 'https://$1/').replace(/\.git$/, ''))} />
        </>}
        <div style={{ height: 1, marginTop: 4, marginBottom: 4, backgroundColor: t.borderLight }} />
        <Label color={t.textSecondary} size={13} lineHeight={19.5} style={{ paddingLeft: 8, paddingTop: 4, paddingBottom: 4, opacity: 0.4 }}>Pull request</Label>
        {git.pull_request ? <EnvironmentRow icon={N.pullRequest} label={`#${git.pull_request.number} ${git.pull_request.title}`} onClick={() => openWeb(git.pull_request!.url)} /> : <EnvironmentRow icon={N.pullRequest} label={busy === 'pr' ? 'Creating…' : 'Create pull request'} disabled={!!busy} onClick={() => void run('pr')} testId="dock-create-pr" />}
      </>}
    </div>
    <div style={{ height: 1, marginLeft: 6, marginRight: 6, marginTop: 4, marginBottom: 4, backgroundColor: t.borderLight }} />
    </>}
    <ErrorLine error={error} retry={refresh} />
    {notice && <Label color={t.textSecondary} size={11} style={{ padding: 12 }}>{notice}</Label>}
    {!files.length ? loaded && !error ? <div style={{ display: 'flex', flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingLeft: 20, paddingRight: 20 }}><Label color={t.textSecondary} size={12} style={{ textAlign: 'center', opacity: 0.7 }}>No changes yet. Files the agent edits in this thread show up here with their diff.</Label></div> : null : <>
      <div style={{ display: 'flex', height: 38, flexShrink: 0, alignItems: 'center', gap: 6, paddingLeft: 14, paddingRight: 6 }}>
        <Icon source={N.pencil} size={14} color={t.text} />
        <Label color={t.text} size={14} lineHeight={21} style={{ flexGrow: group ? 0 : 1 }}>{`${files.length} ${files.length === 1 ? 'file' : 'files'} changed`}</Label>
        <Label color={t.green} size={11}>{`+${files.reduce((n, f) => n + f.additions, 0)}`}</Label>
        <Label color={t.red} size={11}>{`−${files.reduce((n, f) => n + f.deletions, 0)}`}</Label>
        {group && <Label color={t.textTertiary} size={11} truncate style={{ flexGrow: 1 }}>{`· ${changedReposLabel(changedRepos, included.length)}`}</Label>}
        {mode === 'list' && <Button size="sm" variant="ghost" testId="dock-diff-open-all" onClick={() => openTab(thread.id, { kind: 'diff' })}>Open all</Button>}
      </div>
      <virtual-list testId={mode === 'list' ? 'dock-diff-list' : 'diff-tab-list'} style={{ flexGrow: 1, minHeight: 0, width: '100%' }}>
        {rows
          ? rows.map((row) => row.kind === 'repo'
            ? <div key={`repo:${row.group.repo.path}`}><RepoHeader group={row.group} open={row.open} branch={repoBranch(thread, git, row.group.repo.path)} onToggle={() => toggle(row.group.repo.path)} /></div>
            : mode === 'list'
              ? <ChangeRow key={row.file.path} file={row.file} threadId={thread.id} repo={row.repo} />
              : <FileDiff key={`${diff?.to}:${generation}:${row.file.path}`} file={row.file} threadId={thread.id} defaultOpen />)
          : files.map((file) => mode === 'list'
            ? <ChangeRow key={file.path} file={file} threadId={thread.id} />
            : <FileDiff key={`${diff?.to}:${generation}:${file.path}`} file={file} threadId={thread.id} defaultOpen />)}
      </virtual-list>
    </>}
  </>
}

export const FileDiff = memo(function FileDiff({ file, threadId, defaultOpen = false }: { file: FileChange; threadId: string; defaultOpen?: boolean }) {
  const t = useTheme()
  const [open, setOpen] = useState(defaultOpen)
  const [patch, setPatch] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  useEffect(() => {
    if (!open || patch !== null || file.binary) return
    let current = true
    setError(null)
    void getClient()!.call('threads.diff', { thread_id: threadId, path: file.path, include_patch: true }).then((result) => {
      if (current) { setPatch(result.patch); setTruncated(!!result.patch_truncated) }
    }, (e) => { if (current) setError(errorText(e)) })
    return () => { current = false }
  }, [open, patch, file.path, file.binary, threadId, reload])
  return <div style={{ paddingLeft: 8, paddingRight: 8, paddingBottom: 6 }}>
    <div style={{ display: 'flex', flexDirection: 'column', borderWidth: 1, borderColor: t.border, borderRadius: 6, overflow: 'hidden' }}>
      <NativeDiffHeader file={file} open={open} onToggle={() => setOpen(!open)} testId={`dock-file-diff-${file.path}`} />
      {open && <>
        <ErrorLine error={error} retry={() => setReload((n) => n + 1)} />
        {file.binary ? <Label color={t.textSecondary} size={11} style={{ padding: 12 }}>Binary file changed</Label> : patch === null ? !error && <LoadingLines lines={4} testId={`dock-diff-loading-${file.path}`} /> : patch ? <diff testId={`dock-native-diff-${file.path}`} patch={patch} scroll={file.additions + file.deletions > 200} style={{ userSelect: 'text', ...(file.additions + file.deletions > 200 ? { height: 360 } : {}) }} theme={desktopDiffTheme(t, false)} /> : <Label color={t.textSecondary} size={11} style={{ padding: 12 }}>No text changes</Label>}
        {truncated && <Label color={t.textSecondary} size={11} style={{ padding: 12 }}>This diff is too large to show in full. Open the file in your editor to see the remaining changes.</Label>}
      </>}
    </div>
  </div>
})

function EnvironmentRow({ icon, label, trailing, detail, onClick, disabled, busy, testId }: { icon: string; label: string; trailing?: ReactNode; /** A caption under the label (which repositories get a pull request). */ detail?: string; onClick?: () => void; disabled?: boolean; busy?: boolean; testId?: string }) {
  const t = useTheme()
  const row = <div testId={testId} role={onClick ? 'button' : undefined} tabIndex={onClick && !disabled ? 0 : -1} onClick={disabled ? undefined : onClick} onKeyDown={e => { if (!disabled && (e.key === 'enter' || e.key === 'space')) onClick?.() }} style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 28, paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4, borderRadius: 8, opacity: disabled && !busy ? 0.5 : 1, cursor: onClick && !disabled ? 'pointer' : 'default', hover: onClick && !disabled ? { backgroundColor: t.buttonSecondaryHover } : {} }}>
    {busy ? <div style={{ width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Spinner size={12} /></div> : <Icon source={icon} size={16} color={t.text} />}
    <Label color={t.text} size={14} lineHeight={21} truncate style={{ flexGrow: 1 }}>{label}</Label>
    {typeof trailing === 'string' ? <Label color={t.textSecondary} size={14} lineHeight={21}>{trailing}</Label> : trailing ? <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>{trailing}</div> : null}
  </div>
  if (!detail) return row
  return <div style={{ display: 'flex', flexDirection: 'column' }}>{row}<Label color={t.textTertiary} size={12} lineHeight={17} style={{ paddingLeft: 32, paddingRight: 8, paddingBottom: 4 }}>{detail}</Label></div>
}

/** A changed file in the dock: one click opens its diff as the preview tab, a double click keeps it. */
const ChangeRow = memo(function ChangeRow({ file, threadId, repo }: { file: FileChange; threadId: string; /** Under a repository header: the folder is shown inside that repository. */ repo?: string }) {
  const t = useTheme()
  const { name, folder } = fileParts(file, repo ?? '')
  return <div testId={`dock-change-${file.path}`} role="button" tabIndex={0}
    onClick={(e) => openTab(threadId, { kind: 'diff', path: file.path }, { preview: (e.clickCount ?? 1) < 2, focus: false })}
    onKeyDown={(e) => { if (e.key === 'enter' || e.key === 'space') openTab(threadId, { kind: 'diff', path: file.path }) }}
    style={{ display: 'flex', alignItems: 'center', gap: 8, height: 30, marginLeft: 6, marginRight: 6, paddingLeft: 8, paddingRight: 8, borderRadius: 6, cursor: 'pointer', hover: { backgroundColor: t.buttonSecondaryHover } }}>
    <Icon source={diffFileIcons[getFileIconName(file.path)] ?? DOCK_ICONS.changes} size={14} color={t.textSecondary} />
    <Label color={t.text} size={13} truncate style={{ flexShrink: 1 }}>{name}</Label>
    {folder && <Label color={t.textTertiary} size={12} truncate style={{ flexShrink: 2 }}>{folder}</Label>}
    <div style={{ flexGrow: 1 }} />
    {file.additions > 0 && <Label color={t.green} size={11}>{`+${file.additions}`}</Label>}
    {file.deletions > 0 && <Label color={t.red} size={11}>{`−${file.deletions}`}</Label>}
  </div>
})
