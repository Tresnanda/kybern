// The Issues tab of the Pull requests page (#217): one repository's issues in the pull request list's column, filtered by state
// (Open / Closed), search, labels and assignee on GitHub's side and paged ("Show more"); the selected issue, with its comments and
// the action that starts a thread from it, beside it. An issue link in a chat opens here (`openIssue.ts`).
import { Tag01Icon, Target01Icon, User02Icon } from '@hugeicons/core-free-icons'
import { useGpuix, type PublicInstance } from '@gpuix/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { repoKey } from '../../../../../packages/kybern-client/src/actions.ts'
import { asError } from '../../../../../packages/kybern-client/src/problem.ts'
import type { Issue, IssueListResult, PrLabel } from '../../../../../packages/kybern-client/src/types.ts'
import { Icon, glyph } from '../../icons.tsx'
import { Button } from '../../kit/Button.tsx'
import { IconButton } from '../../kit/IconButton.tsx'
import { PickerChip } from '../../kit/PickerChip.tsx'
import { ResizeHandle, useResize } from '../../kit/Resize.tsx'
import { SearchField } from '../../kit/SearchField.tsx'
import { Segmented } from '../../kit/Segmented.tsx'
import { SpinIcon } from '../../kit/Spin.tsx'
import { SwapOnChange } from '../../motion/kit.tsx'
import { N } from '../../nav/glyphs.ts'
import { Menu, MenuItem, MenuLabel, MenuSeparator } from '../../nav/overlay.tsx'
import { useNav } from '../../nav/store.ts'
import { addWindowKeyHandler } from '../../nav/keys.ts'
import { isPrimaryNotAltGr } from '../../platform/keys.ts'
import { useSpaceProjects } from '../../spaces/current.ts'
import { useApp } from '../../state.ts'
import { Label, useTheme } from '../../ui.tsx'
import { column, row } from '../../usage/controls.tsx'
import { RepoPicker, repoChoices, type Choice } from '../actions/ActionsPage.tsx'
import { usePullsTab } from '../actions/store.ts'
import { prCall } from '../client.ts'
import { labelColor } from '../detail/model.ts'
import { load, save } from '../persist.ts'
import { PrLoading, Problem } from '../PrStates.tsx'
import { HEADER_COMPACT_ISSUES, PullsHeader } from '../PullsTabs.tsx'
import { PR_SCROLL_LAYOUT } from '../scroll-layout.ts'
import { IssueDetail } from './IssueDetail.tsx'
import { IssueRow } from './IssueRow.tsx'
import { appendIssues, assigneeChoices, PAGE, STATES, toggleLabel, type IssueFilterState } from './model.ts'

const REPO_KEY = 'pulls.issues.repo'
const TAG = glyph(Tag01Icon)
const PERSON = glyph(User02Icon)
const ISSUE = glyph(Target01Icon)
/** How long typing waits before the search is asked of GitHub. */
const SEARCH_DELAY = 350
/** Issues one list holds at most (ten pages): a longer list is a filter away. */
const MAX_ISSUES = 300

interface Loaded { key: string; issues: Issue[]; hasMore: boolean; error?: Error }

function useDebounced<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => { const timer = setTimeout(() => setSettled(value), delay); return () => clearTimeout(timer) }, [value, delay])
  return settled
}

let lastSelected: { key: string; number: number } | null = null

export function IssuesPage() {
  const t = useTheme()
  const { renderer } = useGpuix()
  const projects = useSpaceProjects()
  const connected = useApp(s => s.status === 'open')
  const selectedThread = useApp(s => s.threads.find(th => th.id === s.selectedId))
  const peek = useNav(s => s.pullsPeek)
  const focus = usePullsTab(s => s.issue)
  const focusSeq = usePullsTab(s => s.issueSeq)
  const choices = useMemo(() => repoChoices(projects), [projects])
  const [repoId, setRepoId] = useState<string | null>(() => load<string | null>(REPO_KEY, null))
  const choice: Choice | undefined = choices.find(c => repoKey(c) === repoId) ?? choices.find(c => c.projectId === selectedThread?.project_id) ?? choices[0]
  const key = choice ? repoKey(choice) : ''
  const member = choice?.repo ? { repo: choice.repo } : {}
  const [state, setState] = useState<IssueFilterState>('open')
  const [query, setQuery] = useState('')
  const search = useDebounced(query.trim(), SEARCH_DELAY)
  const [labels, setLabels] = useState<string[]>([])
  const [assignee, setAssignee] = useState('')
  const [revision, refresh] = useState(0)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [pending, setPending] = useState(false)
  const [paging, setPaging] = useState(false)
  const [repoLabels, setRepoLabels] = useState<{ key: string; labels: PrLabel[] } | null>(null)
  const [selected, setSelected] = useState<number | null>(() => lastSelected && lastSelected.key === key ? lastSelected.number : null)
  const [focused, setFocused] = useState<number | null>(null)
  const searchField = useRef<PublicInstance | null>(null)
  const list = useResize({ initial: 352, min: 304, max: 512, side: 'left', storageKey: 'kybern.pulls.listWidth' })
  const [windowWidth, setWindowWidth] = useState(() => renderer?.getWindowSize?.().width ?? 1280)
  const measure = () => setWindowWidth(renderer?.getWindowSize?.().width ?? 1280)
  const available = windowWidth - 60 - (peek ? 256 : 0)
  const wide = available >= 832
  const listWidth = wide ? list.width : available
  const loadKey = `${key}|${state}|${search}|${labels.join(',')}|${assignee}`

  const select = useCallback((number: number | null) => { setSelected(number); lastSelected = number === null ? null : { key, number } }, [key])
  const pick = (next: { projectId: string; repo?: string }) => {
    const id = repoKey(next)
    setRepoId(id); save(REPO_KEY, id)
    setLabels([]); setAssignee(''); setQuery(''); select(null); setFocused(null)
  }
  // An issue link in a chat opens its repository and the issue.
  const lastFocus = useRef(0)
  useEffect(() => {
    if (!focus || lastFocus.current === focusSeq) return
    lastFocus.current = focusSeq
    pick(focus)
    setState('open')
    setSelected(focus.number); lastSelected = { key: repoKey(focus), number: focus.number }
  }, [focusSeq])

  const ask = useCallback((offset: number): Promise<IssueListResult> => prCall(choice!.projectId, 'github.issue.list', {
    project_id: choice!.projectId, ...member, state, limit: PAGE, offset,
    ...(search ? { search } : {}), ...(labels.length ? { labels } : {}), ...(assignee ? { assignee } : {}),
  }), [loadKey])
  useEffect(() => {
    if (!choice || !connected) return
    let canceled = false
    setPending(true)
    void ask(0).then(result => {
      if (canceled) return
      setLoaded({ key: loadKey, issues: result.issues, hasMore: !!result.has_more })
      if (result.labels?.length) setRepoLabels({ key, labels: result.labels })
      setPending(false)
    }, e => { if (!canceled) { setLoaded({ key: loadKey, issues: [], hasMore: false, error: asError(e) }); setPending(false) } })
    return () => { canceled = true }
  }, [loadKey, revision, connected])
  const shown = loaded?.key === loadKey ? loaded : null
  const issues = shown?.issues ?? []
  const more = () => {
    if (!shown || paging) return
    setPaging(true)
    void ask(issues.length).then(result => {
      setLoaded(cur => cur?.key === loadKey ? { ...cur, issues: appendIssues(cur.issues, result.issues), hasMore: !!result.has_more } : cur)
    }, () => {}).finally(() => setPaging(false))
  }
  useEffect(() => addWindowKeyHandler(e => {
    if (isPrimaryNotAltGr(e.modifiers) && e.key === 'f') { if (!wide) select(null); if (searchField.current) renderer?.focusElement?.(searchField.current.id); return true }
  }), [renderer, wide, select])

  const labelOptions = repoLabels?.key === key ? repoLabels.labels : []
  const people = useMemo(() => assigneeChoices(issues, assignee), [issues, assignee])
  const filtered = !!(search || labels.length || assignee)
  const failure = shown?.error
  const repoName = choice?.repo ? choice.name.split(' / ').pop()! : choice?.name ?? ''
  const move = (at: number, keyName: string) => {
    const next = keyName === 'down' ? Math.min(issues.length - 1, at + 1) : keyName === 'up' ? Math.max(0, at - 1) : keyName === 'home' ? 0 : keyName === 'end' ? issues.length - 1 : -1
    if (next >= 0) setFocused(issues[next]!.number)
  }

  if (!choice) return <div testId="page-issues" style={{ ...column, flexGrow: 1 }}>
    <PullsHeader />
    <div style={{ ...column, gap: 10, padding: 24, paddingTop: 64 }}>
      <Label color={t.text} size={16} weight={500}>No GitHub projects</Label>
      <Label color={t.textSecondary} size={13}>Add a project with a GitHub remote to see its issues here.</Label>
    </div>
  </div>

  const labelWord = labels.length === 0 ? 'Labels' : labels.length === 1 ? labels[0]! : `${labels.length} labels`
  const assigneeWord = !assignee ? 'Assignee' : assignee === '@me' ? 'Assigned to me' : assignee
  const showList = wide || selected === null
  return <div {...PR_SCROLL_LAYOUT} testId="page-issues" onMouseMove={measure} style={{ display: 'flex', flexGrow: 1, minHeight: 0, minWidth: 0 }}>
    {showList && <div style={{ ...column, width: wide ? list.width : '100%', flexShrink: 0, position: 'relative', borderRightWidth: wide ? 1 : 0, borderColor: t.border }}>
      <PullsHeader>
        <RepoPicker testId="issues-repo" choices={choices} current={choice} onPick={pick} compact={listWidth < HEADER_COMPACT_ISSUES} />
        <IconButton testId="issues-refresh" icon={N.refresh} label="Refresh" disabled={pending} onClick={() => refresh(n => n + 1)}><SwapOnChange kind="icon" active={pending ? 'busy' : 'idle'} style={{ width: 16, height: 16 }}>{pending ? <SpinIcon testId="issues-refresh-spinner" source={N.refresh} size={16} color={t.iconSecondary} /> : <Icon source={N.refresh} size={16} color={t.iconSecondary} />}</SwapOnChange></IconButton>
      </PullsHeader>
      <div style={{ ...column, gap: 8, paddingLeft: 12, paddingRight: 12, paddingTop: 2, paddingBottom: 10 }}>
        <div testId="issues-toolbar" style={{ ...row, gap: 6 }}>
          <Segmented size="sm" aria-label="State" testId="issues-state" value={state} options={STATES.map(([value, label]) => ({ value, label }))} onChange={v => { setState(v as IssueFilterState); setFocused(null) }} />
          <div style={{ flexGrow: 1, minWidth: 0 }}><SearchField ref={searchField} size="sm" label="Search issues" testId="issues-search" value={query} placeholder="Search" onChange={setQuery} width="100%" onKeyDown={e => { if (e.key === 'down' && issues[0]) setFocused(issues[0].number) }} /></div>
        </div>
        <div testId="issues-filters" style={{ ...row, gap: 6 }}>
          <Menu testId="issues-labels" align="start" width={248} trigger={open => <PickerChip testId="issues-labels-chip" size="sm" square icon={TAG} open={open} truncate maxWidth={150} selected={labels.length > 0} label={`Labels: ${labelWord}`}>{labelWord}</PickerChip>}>
            {labels.length > 0 && <MenuItem id="clear" testId="issues-labels-clear" label="Clear labels" onSelect={() => setLabels([])} />}
            {labels.length > 0 && <MenuSeparator />}
            {[...labelOptions.filter(l => !labels.includes(l.name)), ...labelOptions.filter(l => labels.includes(l.name))].sort((a, b) => a.name.localeCompare(b.name)).map(l => <MenuItem key={l.name} id={l.name} testId={`issues-label-${l.name}`} keepOpen checked={labels.includes(l.name)} iconNode={<div style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: labelColor(l.color) ?? t.textSecondary }} />} label={l.name} onSelect={() => setLabels(toggleLabel(labels, l.name))} />)}
            {labelOptions.length === 0 && <MenuLabel>No labels</MenuLabel>}
          </Menu>
          <Menu testId="issues-assignee" align="start" width={232} trigger={open => <PickerChip testId="issues-assignee-chip" size="sm" square icon={PERSON} open={open} truncate maxWidth={170} selected={!!assignee} label={`Assignee: ${assigneeWord}`}>{assigneeWord}</PickerChip>}>
            <MenuItem id="anyone" testId="issues-assignee-anyone" label="Anyone" checked={!assignee} onSelect={() => setAssignee('')} />
            <MenuItem id="me" testId="issues-assignee-me" label="Assigned to me" checked={assignee === '@me'} onSelect={() => setAssignee('@me')} />
            {people.length > 0 && <MenuSeparator />}
            {people.map(login => <MenuItem key={login} id={login} label={login} checked={assignee === login} onSelect={() => setAssignee(login)} />)}
          </Menu>
        </div>
      </div>
      <virtual-list {...PR_SCROLL_LAYOUT} testId="issues-list" estimatedItemHeight={72} style={{ flexGrow: 1, minHeight: 0 }}>
        {failure ? <div key="error" style={{ padding: 20 }}><Problem error={failure} projectId={choice.projectId} noun="issues" refresh={() => refresh(n => n + 1)} /></div>
          : !shown ? <div key="loading" style={{ padding: 24 }}><PrLoading label="Loading issues…" kind="list" rows={5} /></div>
          : <>
            {issues.length === 0 && <div key="empty" style={{ ...column, gap: 10, padding: 24, paddingTop: 64 }}>
              <Label color={t.text} size={16} weight={500}>{search ? `No results for “${search}”` : filtered ? 'No matching issues' : `No ${state} issues`}</Label>
              <Label color={t.textSecondary} size={13} lineHeight={20}>{filtered ? 'Change or clear the filters to see more issues.' : `Issues of ${choice.name} appear here.`}</Label>
              {filtered && <Button size="sm" style={{ alignSelf: 'flex-start' }} onClick={() => { setQuery(''); setLabels([]); setAssignee('') }}>Clear filters</Button>}
            </div>}
            {issues.map(issue => <IssueRow key={issue.number} issue={issue} repoName={repoName} projectId={choice.projectId} selected={selected === issue.number} focused={focused === issue.number} onOpen={() => select(issue.number)} onFocus={() => setFocused(issue.number)} onKey={k => move(issues.findIndex(x => x.number === issue.number), k)} />)}
            {shown.hasMore && issues.length < MAX_ISSUES && <div key="more" style={{ ...row, justifyContent: 'center', padding: 12 }}><Button size="sm" testId="issues-more" busy={paging} disabled={paging} onClick={more}>Show more</Button></div>}
            {shown.hasMore && issues.length >= MAX_ISSUES && <div key="cap" style={{ padding: 16, paddingLeft: 20 }}><Label color={t.textTertiary} size={12} lineHeight={16}>Showing the newest 300 issues. Search or filter by label to find older ones.</Label></div>}
          </>}
      </virtual-list>
      {wide && <ResizeHandle testId="issues-list-resize" edge="right" label="Resize issue list" dragging={list.dragging} onPointerDown={list.onPointerDown} onReset={list.reset}
        onKeyDown={e => { const step = e.modifiers?.shift ? 64 : 16; if (e.key === 'left') list.setWidth(list.width - step); else if (e.key === 'right') list.setWidth(list.width + step) }} />}
    </div>}
    {selected !== null
      ? <IssueDetail key={`${key}:${selected}`} project={choice.project} number={selected} {...(choice.repo ? { repo: choice.repo } : {})} onBack={() => select(null)} showBack={!wide} width={available - (wide ? list.width : 0)} />
      : wide && <div style={{ ...column, flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 }}>
        <Icon source={ISSUE} size={24} color={t.textSecondary} />
        <Label color={t.text} size={16} weight={500}>Select an issue</Label>
        <Label color={t.textSecondary} size={14} lineHeight={22} style={{ maxWidth: 320, textAlign: 'center' }}>Read it with its comments, or start a thread from it.</Label>
        <Label color={t.textSecondary} size={13}>↑ ↓ to move · Enter to open</Label>
      </div>}
  </div>
}
