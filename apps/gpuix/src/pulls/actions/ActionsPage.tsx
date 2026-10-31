// The Actions tab of the Pull requests page (ADE-97): the repository's workflow runs on every branch, tags and dispatches
// included, filtered by workflow, status and branch, in the pull request list's column; the selected run, or the form that
// starts a workflow, beside it. Lists refresh every 10 s while a run in them is in progress, every 60 s otherwise, and not at
// all while the window is hidden (`refreshDelay`). Every list read also feeds the finished-run notices (`watch.ts`).
import { PlayIcon } from '@hugeicons/core-free-icons'
import { useGpuix } from '@gpuix/react'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { relativeTime } from '@/lib/format'
import { elapsed, eventWord, isActive, refreshDelay, repoKey, runWord, type ActionsRepo } from '../../../../../packages/kybern-client/src/actions.ts'
import type { ActionsRunsResult, ActionsWorkflowsResult, Project, WorkflowRun } from '../../../../../packages/kybern-client/src/types.ts'
import { glyph, Icon } from '../../icons.tsx'
import { Button } from '../../kit/Button.tsx'
import { RADIUS } from '../../kit/controls.ts'
import { IconButton } from '../../kit/IconButton.tsx'
import { PickerChip } from '../../kit/PickerChip.tsx'
import { ResizeHandle, useResize } from '../../kit/Resize.tsx'
import { SearchField } from '../../kit/SearchField.tsx'
import { Segmented } from '../../kit/Segmented.tsx'
import { SpinIcon } from '../../kit/Spin.tsx'
import { SwapOnChange } from '../../motion/kit.tsx'
import { isWindowVisible, onWindowVisibility } from '../../native/visibility.ts'
import { N } from '../../nav/glyphs.ts'
import { Menu, MenuItem, MenuLabel, MenuSeparator } from '../../nav/overlay.tsx'
import { useNav } from '../../nav/store.ts'
import { useSpaceProjects } from '../../spaces/current.ts'
import { useApp } from '../../state.ts'
import { ink, Label, useTheme } from '../../ui.tsx'
import { column, row } from '../../usage/controls.tsx'
import { prCall } from '../client.ts'
import { hasPullRequests, isGroup, listableMembers } from '../list/model.ts'
import { load, save } from '../persist.ts'
import { PrLoading, Problem } from '../PrStates.tsx'
import { PullsHeader } from '../PullsTabs.tsx'
import { PR_SCROLL_LAYOUT } from '../scroll-layout.ts'
import { Dispatch } from './Dispatch.tsx'
import { RunGlyph } from './glyph.tsx'
import { RunDetail } from './RunDetail.tsx'
import { usePullsTab } from './store.ts'
import { observe } from './watch.ts'

type Status = '' | 'in_progress' | 'failure' | 'success'
const STATUSES = [['', 'All'], ['in_progress', 'Running'], ['failure', 'Failed'], ['success', 'Passed']] as const
const PAGE = 30
/** Runs one list shows at most; older ones are a filter away. */
const MAX_RUNS = 100
const REPO_KEY = 'pulls.actions.repo'
const PLAY = glyph(PlayIcon)

interface Choice extends ActionsRepo { name: string; project: Project }

/** Every repository the space can list runs for: single projects, and each member of a group project. */
function repoChoices(projects: readonly Project[]): Choice[] {
  return projects.filter(hasPullRequests).flatMap(p => isGroup(p)
    ? listableMembers(p).map(m => ({ projectId: p.id, repo: m.path, name: `${p.name} / ${m.name}`, project: p }))
    : [{ projectId: p.id, name: p.name, project: p }])
}

/** Whether the window is on screen, following AppKit's occlusion (and the other platforms' equivalents). */
export function useWindowVisible() {
  const [visible, setVisible] = useState(isWindowVisible)
  useEffect(() => onWindowVisibility(setVisible), [])
  return visible
}

export function ActionsPage() {
  const t = useTheme()
  const { renderer } = useGpuix()
  const projects = useSpaceProjects()
  const connected = useApp(s => s.status === 'open')
  const selectedThread = useApp(s => s.threads.find(th => th.id === s.selectedId))
  const peek = useNav(s => s.pullsPeek)
  const focus = usePullsTab(s => s.focus)
  const focusSeq = usePullsTab(s => s.seq)
  const choices = useMemo(() => repoChoices(projects), [projects])
  const [repoId, setRepoId] = useState<string | null>(() => load<string | null>(REPO_KEY, null))
  const choice = choices.find(c => repoKey(c) === repoId) ?? choices.find(c => c.projectId === selectedThread?.project_id) ?? choices[0]
  const [workflow, setWorkflow] = useState('')
  const [status, setStatus] = useState<Status>('')
  const [branch, setBranch] = useState('')
  const [branchDraft, setBranchDraft] = useState('')
  const [limit, setLimit] = useState(PAGE)
  const [revision, refresh] = useState(0)
  const [data, setData] = useState<{ key: string; result?: ActionsRunsResult; error?: string } | null>(null)
  const [pending, setPending] = useState(false)
  const [workflows, setWorkflows] = useState<{ key: string; result: ActionsWorkflowsResult } | null>(null)
  const [current, setCurrent] = useState<{ key: string; branch: string | null } | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [dispatching, setDispatching] = useState(false)
  const [selectedActive, setSelectedActive] = useState(false)
  const visible = useWindowVisible()
  const list = useResize({ initial: 352, min: 288, max: 512, side: 'left', storageKey: 'kybern.pulls.listWidth' })
  const [windowWidth, setWindowWidth] = useState(() => renderer?.getWindowSize?.().width ?? 1280)
  const measure = () => setWindowWidth(renderer?.getWindowSize?.().width ?? 1280)
  const available = windowWidth - 60 - (peek ? 256 : 0)
  const wide = available >= 832
  const key = choice ? repoKey(choice) : ''
  const member = choice?.repo ? { repo: choice.repo } : {}
  const loadKey = `${key}|${workflow}|${status}|${branch}|${limit}`

  const pick = (next: ActionsRepo) => {
    const id = repoKey(next)
    setRepoId(id); save(REPO_KEY, id)
    setWorkflow(''); setSelected(null); setDispatching(false); setLimit(PAGE)
  }
  // The PR page's checks and a finished-run notice open a repository, a branch or a run here.
  const lastFocus = useRef(0)
  useEffect(() => {
    if (!focus || lastFocus.current === focusSeq) return
    lastFocus.current = focusSeq
    pick(focus)
    setStatus(''); setBranch(focus.branch ?? ''); setBranchDraft(focus.branch ?? '')
    setSelected(focus.runId ?? null)
  }, [focusSeq])

  useEffect(() => {
    if (!choice || !connected) return
    let canceled = false
    void prCall(choice.projectId, 'github.actions.workflows', { project_id: choice.projectId, ...member }).then(result => { if (!canceled) setWorkflows({ key, result }) }, () => {})
    void prCall(choice.projectId, 'git.branches', { project_id: choice.projectId, ...member }).then(r => { if (!canceled) setCurrent({ key, branch: r.current ?? null }) }, () => {})
    return () => { canceled = true }
  }, [key, connected])
  const ownBranch = current?.key === key ? current.branch : undefined

  useEffect(() => {
    if (!choice || !connected) return
    let canceled = false
    setPending(true)
    void prCall(choice.projectId, 'github.actions.runs', {
      project_id: choice.projectId, ...member, per_page: Math.min(limit, MAX_RUNS),
      ...(workflow ? { workflow } : {}), ...(status ? { status } : {}), ...(branch ? { branch } : {}),
    }).then(result => {
      if (canceled) return
      setData({ key: loadKey, result }); setPending(false)
      observe(choice, result.runs, result.viewer, ownBranch)
    }, e => { if (!canceled) { setData({ key: loadKey, error: String(e) }); setPending(false) } })
    return () => { canceled = true }
  }, [loadKey, revision, connected])

  const shown = data?.key === loadKey ? data : null
  const runs = shown?.result?.runs ?? []
  const active = runs.some(isActive) || selectedActive
  // The refresh rule: 10 s with a run in progress on screen, 60 s otherwise, nothing while hidden; shown again, read at once.
  useEffect(() => {
    const delay = refreshDelay({ active, onScreen: true, windowVisible: visible })
    if (delay === null || !shown) return
    const timer = setTimeout(() => refresh(n => n + 1), delay)
    return () => clearTimeout(timer)
  }, [active, visible, shown])
  const wasVisible = useRef(visible)
  useEffect(() => { if (visible && !wasVisible.current) refresh(n => n + 1); wasVisible.current = visible }, [visible])

  const workflowList = workflows?.key === key ? workflows.result.workflows : []
  const workflowName = workflowList.find(w => String(w.id) === workflow)?.name ?? 'All workflows'
  const failure = shown?.error
  const open = (id: number) => { setSelected(id); setDispatching(false) }
  const selectedRun = runs.find(r => r.id === selected)
  const detailWidth = available - (wide ? list.width : 0)
  const showList = wide || (selected === null && !dispatching)

  if (!choice) return <div testId="page-actions" style={{ ...column, flexGrow: 1 }}>
    <PullsHeader />
    <div style={{ ...column, gap: 10, padding: 24, paddingTop: 64 }}>
      <Label color={t.text} size={16} weight={500}>No GitHub projects</Label>
      <Label color={t.textSecondary} size={13}>Add a project with a GitHub remote to see its workflow runs here.</Label>
    </div>
  </div>

  return <div {...PR_SCROLL_LAYOUT} testId="page-actions" onMouseMove={measure} style={{ display: 'flex', flexGrow: 1, minHeight: 0, minWidth: 0 }}>
    {showList && <div style={{ ...column, width: wide ? list.width : '100%', flexShrink: 0, position: 'relative', borderRightWidth: wide ? 1 : 0, borderColor: t.border }}>
      <PullsHeader>
        <RepoPicker choices={choices} current={choice} onPick={pick} />
        <IconButton testId="actions-dispatch-open" icon={PLAY} label="Run workflow" active={dispatching} onClick={() => { setDispatching(true); setSelected(null) }} />
        <IconButton testId="actions-refresh" icon={N.refresh} label="Refresh" disabled={pending} onClick={() => refresh(n => n + 1)}><SwapOnChange kind="icon" active={pending ? 'busy' : 'idle'} style={{ width: 16, height: 16 }}>{pending ? <SpinIcon source={N.refresh} size={16} color={t.iconSecondary} /> : <Icon source={N.refresh} size={16} color={t.iconSecondary} />}</SwapOnChange></IconButton>
      </PullsHeader>
      <div style={{ ...column, gap: 8, paddingLeft: 12, paddingRight: 12, paddingTop: 2, paddingBottom: 10 }}>
        <Segmented size="sm" fill aria-label="Status" testId="actions-status" value={status} options={STATUSES.map(([value, label]) => ({ value, label }))} onChange={v => { setStatus(v as Status); setLimit(PAGE) }} />
        <div style={{ ...row, gap: 6 }}>
          <div style={{ display: 'flex', flexShrink: 0 }}><Menu testId="actions-workflow" align="start" width={264} trigger={open => <PickerChip size="sm" open={open} truncate maxWidth={150} selected={!!workflow} label={`Workflow: ${workflowName}`}>{workflowName}</PickerChip>}>
            <MenuItem id="all" label="All workflows" onSelect={() => { setWorkflow(''); setLimit(PAGE) }} />
            {workflowList.length > 0 && <MenuSeparator />}
            {workflowList.map(w => <MenuItem key={w.id} id={String(w.id)} testId={`actions-workflow-${w.id}`} label={w.name} {...(w.state !== 'active' ? { detail: 'Off' } : {})} onSelect={() => { setWorkflow(String(w.id)); setLimit(PAGE) }} />)}
          </Menu></div>
          <div style={{ flexGrow: 1, minWidth: 0 }}>
            <SearchField label="Filter by branch" testId="actions-branch" value={branchDraft} placeholder="Branch" width="100%" onChange={v => { setBranchDraft(v); if (!v) setBranch('') }}
              onBlur={() => setBranch(branchDraft.trim())} onKeyDown={e => { if (e.key === 'enter') setBranch(branchDraft.trim()) }} />
          </div>
        </div>
      </div>
      <virtual-list {...PR_SCROLL_LAYOUT} testId="actions-list" estimatedItemHeight={64} style={{ flexGrow: 1, minHeight: 0 }}>
        {failure ? <div key="error" style={{ padding: 20 }}><Problem error={failure} refresh={() => refresh(n => n + 1)} /></div>
          : !shown ? <div key="loading" style={{ padding: 24 }}><PrLoading label="Loading workflow runs…" kind="list" rows={6} /></div>
          : <>
            {runs.length === 0 && <div key="empty" style={{ ...column, gap: 10, padding: 24, paddingTop: 64 }}>
              <Label color={t.text} size={16} weight={500}>{branch || status || workflow ? 'No matching runs' : 'No workflow runs yet'}</Label>
              <Label color={t.textSecondary} size={13} lineHeight={20}>{branch || status || workflow ? 'Change or clear the filters to see more runs.' : `Runs of ${choice.name}'s GitHub Actions workflows appear here.`}</Label>
              {(branch || status || workflow) && <Button size="sm" style={{ alignSelf: 'flex-start' }} onClick={() => { setBranch(''); setBranchDraft(''); setStatus(''); setWorkflow('') }}>Clear filters</Button>}
            </div>}
            {runs.map(r => <RunRow key={r.id} run={r} selected={r.id === selected} own={!!ownBranch && r.head_branch === ownBranch} onOpen={() => open(r.id)} />)}
            {shown.result?.has_more && limit < MAX_RUNS && <div key="more" style={{ ...row, justifyContent: 'center', padding: 12 }}><Button size="sm" testId="actions-more" busy={pending} onClick={() => setLimit(l => Math.min(MAX_RUNS, l + PAGE))}>Show more runs</Button></div>}
            {shown.result?.has_more && limit >= MAX_RUNS && <div key="cap" style={{ padding: 16 }}><Label color={t.textTertiary} size={12} lineHeight={16}>Showing the latest 100 runs. Filter by workflow or branch to find older ones.</Label></div>}
          </>}
      </virtual-list>
      {wide && <ResizeHandle testId="actions-list-resize" edge="right" label="Resize run list" dragging={list.dragging} onPointerDown={list.onPointerDown} onReset={list.reset}
        onKeyDown={e => { const step = e.modifiers?.shift ? 64 : 16; if (e.key === 'left') list.setWidth(list.width - step); else if (e.key === 'right') list.setWidth(list.width + step) }} />}
    </div>}
    {dispatching ? <Dispatch key={`dispatch-${key}`} target={choice} workflows={workflowList} defaultBranch={workflows?.key === key ? workflows.result.default_branch ?? '' : ''} ownBranch={ownBranch ?? null} initial={workflow} showBack={!wide}
        onClose={() => setDispatching(false)} onStarted={() => { setDispatching(false); refresh(n => n + 1) }} />
      : selected !== null ? <RunDetail key={`${key}:${selected}`} target={choice} runId={selected} listed={selectedRun} width={detailWidth} showBack={!wide} visible={visible} onBack={() => setSelected(null)} onActive={setSelectedActive} onChanged={() => refresh(n => n + 1)} />
      : wide && <div style={{ ...column, flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 }}>
        <Icon source={PLAY} size={24} color={t.textSecondary} />
        <Label color={t.text} size={16} weight={500}>Select a run</Label>
        <Label color={t.textSecondary} size={14} lineHeight={22} style={{ maxWidth: 320, textAlign: 'center' }}>Read its jobs and logs, run failed jobs again or send a failure to an agent.</Label>
      </div>}
  </div>
}

function RepoPicker({ choices, current, onPick }: { choices: Choice[]; current: Choice; onPick: (c: ActionsRepo) => void }) {
  const t = useTheme()
  const groups = [...new Set(choices.filter(c => c.repo).map(c => c.projectId))]
  return <Menu testId="actions-repo" align="end" width={264} trigger={open => <PickerChip size="sm" open={open} truncate maxWidth={150} label={`Repository: ${current.name}`}>{current.repo ? current.name.split(' / ').pop()! : current.name}</PickerChip>}>
    {choices.filter(c => !c.repo).map(c => <MenuItem key={repoKey(c)} id={repoKey(c)} testId={`actions-repo-${c.projectId}`} label={c.name} iconNode={<Lead on={repoKey(c) === repoKey(current)} color={t.link} />} onSelect={() => onPick(c)} />)}
    {groups.map(id => <div key={id} style={column}>
      <MenuSeparator />
      <MenuLabel>{choices.find(c => c.projectId === id)!.project.name}</MenuLabel>
      {choices.filter(c => c.projectId === id && c.repo).map(c => <MenuItem key={repoKey(c)} id={repoKey(c)} label={c.name.split(' / ').pop()!} iconNode={<Lead on={repoKey(c) === repoKey(current)} color={t.link} />} onSelect={() => onPick(c)} />)}
    </div>)}
  </Menu>
}

function Lead({ on, color }: { on: boolean; color: string }) {
  return <div style={{ width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{on && <Icon source={N.check} size={14} color={color} />}</div>
}

/** One run: its mark, the commit or dispatch title (two lines at most), then workflow and number, branch, trigger and age. */
const RunRow = memo(function RunRow({ run, selected, own, onOpen }: { run: WorkflowRun; selected: boolean; own: boolean; onOpen: () => void }) {
  const t = useTheme()
  const time = isActive(run) ? elapsed(run.started_at ?? run.created_at, undefined) : relativeTime(run.created_at)
  return <div style={{ display: 'flex', paddingLeft: 8, paddingRight: 8 }}>
    <div testId={`actions-run-${run.id}`} role="button" tabIndex={0} aria-current={selected ? 'page' : undefined} aria-label={`${run.title}, ${run.workflow_name} #${run.number}, ${runWord(run)}`}
      onClick={onOpen} onKeyDown={e => { if (e.key === 'enter' || e.key === 'space') onOpen() }}
      style={{ ...row, alignItems: 'flex-start', flexGrow: 1, gap: 10, paddingLeft: 10, paddingRight: 10, paddingTop: 8, paddingBottom: 9, borderRadius: RADIUS.md, backgroundColor: selected ? ink(t, .07) : 'transparent', hover: { backgroundColor: selected ? ink(t, .07) : t.hover } }}>
      <div style={{ paddingTop: 2 }}><RunGlyph item={run} /></div>
      <div style={{ ...column, flexGrow: 1, flexShrink: 1, gap: 4 }}>
        <div style={{ ...row, alignItems: 'flex-start', gap: 8 }}>
          <Label color={t.text} size={13} lineHeight={18} weight={500} style={{ flexGrow: 1, minWidth: 0, lineClamp: 2, textOverflow: 'ellipsis' }}>{run.title || run.workflow_name}</Label>
          <Label color={t.textTertiary} size={12} lineHeight={18} style={{ flexShrink: 0 }}>{time}</Label>
        </div>
        <div style={{ ...row, gap: 6 }}>
          <Label color={t.textSecondary} size={12} lineHeight={16} style={{ flexShrink: 0 }}>{`${run.workflow_name} #${run.number}`}</Label>
          {run.head_branch && <div style={{ ...row, gap: 3, flexShrink: 1, minWidth: 0 }}>
            <Icon source={N.branch} size={11} color={own ? t.link : t.textTertiary} style={{ flexShrink: 0 }} />
            <Label color={own ? t.link : t.textTertiary} size={12} lineHeight={16} truncate>{run.head_branch}</Label>
          </div>}
          <Label color={t.textTertiary} size={12} lineHeight={16} style={{ flexShrink: 0 }}>{eventWord(run.event)}</Label>
        </div>
      </div>
    </div>
  </div>
})
