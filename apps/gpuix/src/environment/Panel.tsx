import { activeEnvironment } from '../shell/environment.ts'
import { useNav } from '../nav/store.ts'
import { spawn } from 'node:child_process'
import { useEffect, useState, type ReactNode } from 'react'
import { motion } from '@gpuix/react'
import { GitCommitIcon, GithubIcon, Edit02Icon, Copy01Icon, ArrowUpRight01Icon } from '@hugeicons/core-free-icons'
import type { Diff, GitStatus, Thread } from '../../../../packages/kybern-client/src/types.ts'
import { Icon, glyph } from '../icons.tsx'
import { N } from '../nav/glyphs.ts'
import { Menu, MenuItem, MenuLabel, MenuSeparator, muted } from '../nav/overlay.tsx'
import { surfaceShadow } from '../composer/Menu.tsx'
import { getClient, onOpenEvent, useApp } from '../state.ts'
import { chooseTab, setDock, type DockTab } from '../dock/store.ts'
import { openWeb } from '../dock/Diff.tsx'
import { load, save } from '../shell/persist.ts'
import { toast } from '../shell/toasts.tsx'
import { errorText } from '../nav/actions.ts'
import { Label, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { copyText } from '../transcript/store.ts'
import { ENVIRONMENT_MOTION, useEnvironmentPanel, useEnvironmentDock, openEnvironmentPanel, closeEnvironmentPanel, finishEnvironmentClose } from './store.ts'
import { ThreadNote } from './ThreadNote.tsx'

const G = { commit: glyph(GitCommitIcon), github: glyph(GithubIcon), changes: glyph(Edit02Icon), copy: glyph(Copy01Icon), external: glyph(ArrowUpRight01Icon) }
const SECTIONS = [['changes', 'Changes'], ['repository', 'Repository'], ['pullRequest', 'Pull request'], ['editor', 'Editor'], ['notes', 'Notes']] as const
type Section = typeof SECTIONS[number][0]
export function EnvironmentTrigger({ threadId }: { threadId: string }) {
  const t = useTheme()
  const panel = useEnvironmentPanel()
  const open = panel?.threadId === threadId && !panel.leaving
  const toggle = (keyboard = false) => {
    if (open) return closeEnvironmentPanel()
    openEnvironmentPanel(threadId, keyboard)
  }
  return <div testId="environment-toggle" tabIndex={0} aria-label="Environment" aria-expanded={open}
    onClick={() => toggle()} onKeyDown={(e) => { if (e.key === 'enter' || e.key === 'space') toggle(true) }}
    style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 8, backgroundColor: open ? t.buttonSecondaryHover : undefined, hover: { backgroundColor: t.buttonSecondaryHover } }}>
    <Icon source={N.window} size={16} color={t.textSecondary} />
  </div>
}

/** Keep deferred layers out of the title bar's cached island, which cannot replay their hit bounds. */
export function EnvironmentOverlay() {
  const t = useTheme()
  const panel = useEnvironmentPanel()
  const dock = useEnvironmentDock()
  const selected = useApp((s) => s.selectedId)
  const visible = useNav((s) => s.page === 'home' && !s.settingsOpen)
  useEffect(() => { if (panel && (!visible || selected !== panel.threadId)) closeEnvironmentPanel(true) }, [selected, visible, panel?.threadId])
  if (!panel || !visible || selected !== panel.threadId || !dock) return null
  const { threadId, leaving, keyboard } = panel
  return <motion.div
    initial={keyboard || REDUCED_MOTION ? false : { opacity: 0, translateX: 288 }}
    animate={{ opacity: leaving ? 0 : 1, translateX: leaving && !REDUCED_MOTION && !keyboard ? 288 : 0 }}
    transition={REDUCED_MOTION || keyboard ? { duration: 0 } : ENVIRONMENT_MOTION}
    onMotionComplete={() => { if (leaving) finishEnvironmentClose(panel.generation) }}
    style={{ position: 'absolute', left: dock.x + dock.width - 300, top: dock.y + 12, pointerEvents: leaving ? 'none' : 'auto' }}>
    <div testId="environment-panel" tabIndex={0} autoFocus onKeyDown={(e) => { if (e.key === 'escape') closeEnvironmentPanel() }}
      style={{ display: 'flex', flexDirection: 'column', width: 288, maxHeight: Math.max(120, dock.height - 24), overflow: 'scroll', padding: 6, gap: 2, borderRadius: 16, borderWidth: 1, borderColor: t.borderLight, backgroundColor: t.popover, boxShadow: surfaceShadow(t), pointerEvents: leaving ? 'none' : 'auto' }}>
      <EnvironmentPanel key={threadId} threadId={threadId} />
    </div>
  </motion.div>
}

function Row({ icon, label, trailing, onClick, disabled, testId, decorative }: { icon: string; label: string; trailing?: ReactNode; onClick?: () => void; disabled?: boolean; testId?: string; decorative?: boolean }) {
  const t = useTheme()
  return <div testId={testId} tabIndex={onClick && !disabled ? 0 : -1} onClick={disabled ? undefined : onClick} onKeyDown={(e) => { if (!disabled && (e.key === 'enter' || e.key === 'space')) onClick?.() }}
    style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, width: '100%', minHeight: 29, paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4, borderRadius: 8, opacity: disabled ? 0.5 : 1, pointerEvents: decorative ? 'none' : 'auto', hover: { backgroundColor: t.buttonSecondaryHover } }}>
    <Icon source={icon} size={16} color={t.text} /><Label color={t.text} size={14} lineHeight={21} truncate style={{ flexGrow: 1 }}>{label}</Label><div style={{ display: 'flex', alignItems: 'center', gap: 4, pointerEvents: 'none' }}>{trailing}</div>
  </div>
}
function SectionTitle({ children }: { children: string }) {
  const t = useTheme()
  return <><div style={{ height: 1, backgroundColor: t.borderLight, marginTop: 4, marginBottom: 4 }} /><Label color={muted(t, 0.4)} size={13} lineHeight={16} style={{ paddingLeft: 8, paddingTop: 4, paddingBottom: 4 }}>{children}</Label></>
}

function EnvironmentPanel({ threadId }: { threadId: string }) {
  const t = useTheme()
  const thread = useApp((s) => s.open.thread ?? s.threads.find((th) => th.id === threadId)) as Thread | undefined
  const project = useApp((s) => s.projects.find((p) => p.id === thread?.project_id))
  const [hidden, setHidden] = useState(() => load<Partial<Record<Section, boolean>>>('kybern.env.hidden', {}))
  const [notesOpen, setNotesOpen] = useState(() => load('kybern.env.notes', true))
  const [git, setGit] = useState<GitStatus | null>(null)
  const [diff, setDiff] = useState<Diff | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [reload, setReload] = useState(0)
  const refresh = () => setReload((n) => n + 1)
  useEffect(() => {
    let live = true
    setError('')
    const client = getClient()
    if (!client) return
    // A new thread has no checkpoint yet. Its diff failure must not hide valid
    // repository information (branch, remotes and working-tree status).
    void Promise.allSettled([client.call('git.status', { thread_id: threadId }), client.call('threads.diff', { thread_id: threadId, include_patch: false })]).then(([status, changes]) => {
      if (!live) return
      setGit(status.status === 'fulfilled' ? status.value : null)
      setDiff(changes.status === 'fulfilled' ? changes.value : null)
      const failures = [status, changes].filter((result) => result.status === 'rejected' && !(result === changes && errorText(result.reason).includes('thread has no checkpoints yet')))
      setError(failures.map((result) => errorText((result as PromiseRejectedResult).reason)).join(' · '))
    })
    return () => { live = false }
  }, [threadId, reload])
  useEffect(() => onOpenEvent((e) => { if (e.thread_id === threadId && (e.kind === 'turn_completed' || e.kind === 'turn_failed')) refresh() }), [threadId])
  const cwd = thread?.cwd ?? project?.path ?? ''
  const chevron = <Icon source={N.chevronDown} size={12} color={t.textSecondary} />
  const external = <Icon source={G.external} size={14} color={t.text} />
  const local = activeEnvironment().local
  const dock = (tab: DockTab) => { chooseTab(threadId, tab); setDock(threadId, { open: true }) }
  const run = async (kind: 'commit' | 'pr') => {
    if (busy) return
    setBusy(true)
    const client = getClient()!
    try {
      if (kind === 'commit') {
        const result = await client.call('git.commit', { thread_id: threadId })
        if (getClient() !== client) return
        toast('Committed', { description: result.message })
      } else {
        const result = await client.call('github.pr.create', { thread_id: threadId })
        if (getClient() !== client) return
        toast('Pull request opened', { description: result.title, action: { label: 'Open', onClick: () => openWeb(result.url) } })
      }
      refresh()
    } catch (e) { if (getClient() !== client) return; toast.error(kind === 'commit' ? 'Unable to commit' : 'Unable to create pull request', { description: errorText(e) }) } finally { setBusy(false) }
  }
  return <>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 8 }}><Label color={muted(t, 0.4)} size={14} lineHeight={21}>Environment</Label>
      <Menu testId="environment-sections" align="end" width={192} trigger={() => <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, pointerEvents: 'none' }}><Icon source={N.settings} size={14} color={t.textSecondary} /></div>}><MenuLabel>Sections</MenuLabel>{SECTIONS.map(([key, label]) => <MenuItem key={key} id={key} testId={`environment-section-${key}`} label={label} checked={!hidden[key]} keepOpen onSelect={() => { const next = { ...hidden, [key]: !hidden[key] }; setHidden(next); save('kybern.env.hidden', next) }} />)}</Menu>
    </div>
    {!hidden.changes && <Row testId="environment-changes" icon={G.changes} label="Changes" disabled={!diff?.files.length} onClick={() => dock('changes')} trailing={(diff?.files.length ?? 0) > 0 && <><Label color={t.green} size={12}>{`+${diff?.files.reduce((n, f) => n + f.additions, 0) ?? 0}`}</Label><Label color={t.red} size={12}>{`−${diff?.files.reduce((n, f) => n + f.deletions, 0) ?? 0}`}</Label></>} />}
    <Menu testId="environment-running" width={260} trigger={() => <Row decorative icon={thread?.worktree ? N.worktree : N.laptop} label={thread?.worktree ? 'Worktree' : local ? 'Local' : 'Remote'} trailing={chevron} />}><MenuLabel>Running in</MenuLabel><MenuItem id="cwd" label={cwd || 'Local'} checked disabled={!local || !cwd} onSelect={() => spawn('open', ['-R', cwd], { stdio: 'ignore' }).on('error', () => {})} /></Menu>
    {git?.is_git && <><Menu testId="environment-branch" width={260} trigger={() => <Row decorative icon={N.branch} label={git.branch ?? 'detached'} trailing={chevron} />}><MenuLabel>Branch</MenuLabel><MenuItem id="branch" label={git.branch ?? 'detached'} detail={`${git.ahead ? `↑${git.ahead}` : ''}${git.behind ? ` ↓${git.behind}` : ''}`} disabled onSelect={() => {}} />{git.upstream && <MenuItem id="upstream" label={`Tracks ${git.upstream}`} disabled onSelect={() => {}} />}<MenuSeparator /><MenuItem id="copy" icon={G.copy} label="Copy branch name" onSelect={() => copyText(git.branch ?? '')} /></Menu>
      <Row testId="environment-commit" icon={G.commit} label={busy ? 'Working…' : 'Commit and push'} disabled={busy || git.dirty_files === 0} onClick={() => void run('commit')} trailing={<Label color={t.textSecondary} size={12}>{String(git.dirty_files)}</Label>} />
    </>}
    {!hidden.repository && git?.remote_url && <><SectionTitle>Repository</SectionTitle><Row icon={G.github} label={/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/.exec(git.remote_url)?.[1] ?? git.remote_url} trailing={external} onClick={() => openWeb(git.remote_url!.replace(/^git@([^:]+):/, 'https://$1/').replace(/\.git$/, ''))} /></>}
    {!hidden.pullRequest && git?.is_git && <><SectionTitle>Pull request</SectionTitle>{git.pull_request ? <Row icon={N.pullRequest} label={`#${git.pull_request.number} ${git.pull_request.title}`} trailing={external} onClick={() => openWeb(git.pull_request!.url)} /> : <Row icon={N.pullRequest} label="Create pull request" disabled={busy || !git.remote_url} onClick={() => void run('pr')} />}</>}
    {!hidden.editor && <><SectionTitle>Editor</SectionTitle><Row testId="environment-editor" icon={N.layoutSidebar} label="Editor view" onClick={() => dock('explorer')} /><Menu testId="environment-folder" width={192} trigger={() => <Row decorative icon={N.folder} label="Open in Finder" trailing={chevron} />}><MenuItem id="reveal" icon={N.folder} label="Reveal in Finder" disabled={!local || !cwd} onSelect={() => spawn('open', ['-R', cwd], { stdio: 'ignore' }).on('error', () => {})} /><MenuItem id="open" icon={G.external} label="Open folder" disabled={!local || !cwd} onSelect={() => spawn('open', [cwd], { stdio: 'ignore' }).on('error', () => {})} /><MenuItem id="copy" icon={G.copy} label="Copy path" onSelect={() => copyText(cwd)} /></Menu></>}
    {!hidden.notes && <><div style={{ height: 1, backgroundColor: t.borderLight, marginTop: 4, marginBottom: 4 }} /><div testId="environment-notes-toggle" tabIndex={0} aria-expanded={notesOpen} onClick={() => { setNotesOpen(!notesOpen); save('kybern.env.notes', !notesOpen) }} onKeyDown={(e) => { if (e.key === 'enter' || e.key === 'space') { setNotesOpen(!notesOpen); save('kybern.env.notes', !notesOpen) } }} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, minHeight: 25, paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4, borderRadius: 8, hover: { backgroundColor: t.buttonSecondaryHover } }}><Label color={muted(t, 0.4)} size={13} lineHeight={16}>Notes</Label><Icon source={notesOpen ? N.chevronDown : N.chevronRight} size={12} color={muted(t, 0.6)} /></div>{notesOpen && <div style={{ display: 'flex', flexDirection: 'column', paddingTop: 2 }}><ThreadNote key={threadId} threadId={threadId} /></div>}</>}
  </>
}
