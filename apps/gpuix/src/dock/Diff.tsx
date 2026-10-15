import { spawn } from 'node:child_process'
import { memo, useCallback, useEffect, useState } from 'react'
import type { Diff as ThreadDiff, FileChange, GitStatus, Thread } from '../../../../packages/kybern-client/src/types.ts'
import { Icon } from '../icons.tsx'
import { ISLAND } from '../MatrixLoader.tsx'
import { errorText } from '../nav/actions.ts'
import { N } from '../nav/glyphs.ts'
import { Chevron, IconButton } from '../sidebar/rows.tsx'
import { getClient, onOpenEvent } from '../state.ts'
import { cachedMarkdownTheme } from '../transcript/kit.tsx'
import { Label, useTheme } from '../ui.tsx'
import { Action, DockEmpty, ErrorLine, Section } from './parts.tsx'

export function openWeb(url: string) {
  // Only web links from daemon records; never hand arbitrary schemes to macOS.
  if (/^https?:\/\//i.test(url)) spawn('open', [url], { stdio: 'ignore' }).on('error', () => {})
}

export function DiffPane({ thread, onStats }: { thread: Thread; onStats: (adds: number, dels: number) => void }) {
  const t = useTheme()
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
    void Promise.all([client.call('threads.diff', { thread_id: thread.id, include_patch: false }), client.call('git.status', { thread_id: thread.id })]).then(([changes, status]) => {
      if (!current) return
      setDiff(changes); setGit(status); setLoaded(true)
      onStats(changes.files.reduce((n, f) => n + f.additions, 0), changes.files.reduce((n, f) => n + f.deletions, 0))
    }, (e) => { if (current) { setError(errorText(e)); setLoaded(true) } })
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
  const files = diff?.files ?? []
  return <>
    <div {...ISLAND} style={{ display: 'flex', flexDirection: 'column', width: '100%', height: git?.is_git ? 146 : 38, flexShrink: 0 }}>
      <Section label="Environment"><IconButton icon={N.refresh} size={28} label="Refresh diff" testId="dock-diff-refresh" onClick={refresh} /></Section>
      {git?.is_git && <>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 28, paddingLeft: 14, paddingRight: 14 }}>
          <Icon source={N.branch} size={14} color={t.textSecondary} />
          <Label color={t.text} size={12} truncate style={{ flexGrow: 1 }}>{git.branch ?? 'detached'}</Label>
          <Label color={t.textSecondary} size={11}>{`${git.ahead ? `↑${git.ahead}` : ''}${git.behind ? ` ↓${git.behind}` : ''}`}</Label>
        </div>
        <div style={{ display: 'flex', paddingLeft: 6, gap: 4 }}>
          {/* Match the desktop contract. git.commit currently does not push;
              that existing daemon gap is tracked separately from this port. */}
          <Action disabled={!!busy || git.dirty_files === 0} onClick={() => void run('commit')} testId="dock-commit">{busy === 'commit' ? 'Committing…' : 'Commit and push'}</Action>
          {git.remote_url && <Action onClick={() => openWeb(git.remote_url!.replace(/^git@([^:]+):/, 'https://$1/').replace(/\.git$/, ''))}>Repository ↗</Action>}
        </div>
        <Section label="Pull request" />
        <div style={{ display: 'flex', paddingLeft: 6 }}>
          {git.pull_request ? <Action onClick={() => openWeb(git.pull_request!.url)}>{`#${git.pull_request.number} ${git.pull_request.title} ↗`}</Action> : <Action disabled={!!busy} onClick={() => void run('pr')} testId="dock-create-pr">{busy === 'pr' ? 'Creating…' : 'Create pull request'}</Action>}
        </div>
      </>}
    </div>
    <ErrorLine error={error} retry={refresh} />
    {notice && <Label color={t.textSecondary} size={11} style={{ padding: 12 }}>{notice}</Label>}
    {!files.length ? loaded && !error ? <DockEmpty icon={N.branch} title="No changes yet" body="Files the agent edits in this thread show up here with their diff." /> : null : <>
      <Section label={`${files.length} ${files.length === 1 ? 'file' : 'files'} changed`}>
        <Label color={t.green} size={11}>{`+${files.reduce((n, f) => n + f.additions, 0)}`}</Label>
        <Label color={t.red} size={11}>{`−${files.reduce((n, f) => n + f.deletions, 0)}`}</Label>
      </Section>
      <virtual-list testId="dock-diff-list" style={{ flexGrow: 1, minHeight: 0, width: '100%' }}>
        {files.map((file) => <FileDiff key={`${diff?.to}:${generation}:${file.path}`} file={file} threadId={thread.id} />)}
      </virtual-list>
    </>}
  </>
}

const FileDiff = memo(function FileDiff({ file, threadId }: { file: FileChange; threadId: string }) {
  const t = useTheme()
  const [open, setOpen] = useState(false)
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
    <div style={{ display: 'flex', flexDirection: 'column', borderWidth: 0.6, borderColor: t.borderLight, borderRadius: 8 }}>
      <div testId={`dock-file-diff-${file.path}`} role="button" onClick={() => setOpen(!open)} style={{ display: 'flex', alignItems: 'center', gap: 6, height: 34, paddingLeft: 8, paddingRight: 8, cursor: 'pointer', borderRadius: 8, backgroundColor: t.codeSurface }}>
        <Chevron open={open} color={t.textSecondary} size={12} />
        <Label color={t.text} size={12} truncate style={{ flexGrow: 1 }}>{file.path}</Label>
        <Label color={t.green} size={10}>{`+${file.additions}`}</Label><Label color={t.red} size={10}>{`−${file.deletions}`}</Label>
      </div>
      {open && <>
        <ErrorLine error={error} retry={() => setReload((n) => n + 1)} />
        {file.binary ? <Label color={t.textSecondary} size={11} style={{ padding: 12 }}>Binary file changed</Label> : patch === null ? !error && <Label color={t.textSecondary} size={11} style={{ padding: 12 }}>Loading diff…</Label> : patch ? <diff testId={`dock-native-diff-${file.path}`} patch={patch} wordDiff scroll={file.additions + file.deletions > 200} style={file.additions + file.deletions > 200 ? { height: 360 } : undefined} theme={cachedMarkdownTheme(t)} /> : <Label color={t.textSecondary} size={11} style={{ padding: 12 }}>No text changes</Label>}
        {truncated && <Label color={t.textSecondary} size={11} style={{ padding: 12 }}>This diff is too large to show in full. Open the file in your editor to see the remaining changes.</Label>}
      </>}
    </div>
  </div>
})
