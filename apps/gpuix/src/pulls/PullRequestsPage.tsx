import { Icon } from '../icons.tsx'
import { N } from '../nav/glyphs.ts'
import { onEnvironmentChange } from '../shell/environment.ts'
import { useGpuix, type PublicInstance } from '@gpuix/react'
import { memo, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { relativeTime } from '@/lib/format'
import { mapWithConcurrency } from '@/lib/workload'
import { classifyPrError } from '@/state/prReviewModel'
import type { Project, PullRequest } from '../../../../packages/kybern-client/src/types.ts'
import { getClient, useApp } from '../state.ts'
import { Menu, MenuItem } from '../nav/overlay.tsx'
import { addWindowKeyHandler } from '../nav/keys.ts'
import { useNav } from '../nav/store.ts'
import { ink, Label, useTheme } from '../ui.tsx'
import { Button, column, Header, row, Segments } from '../usage/controls.tsx'
import { Detail } from './PrDetail.tsx'
import { Problem } from './PrStates.tsx'

interface Row { project: Project; pr: PullRequest }
type Filter = 'open' | 'merged' | 'closed' | 'all'
const FILTERS = [['open', 'Open'], ['merged', 'Merged'], ['closed', 'Closed'], ['all', 'All']] as const
const cache = new Map<string, { until: number; rows: PullRequest[] }>()
let lastSelection: { project: Project; number: number } | null = null

export function PullRequestsPage() {
  const t = useTheme()
  const { renderer } = useGpuix()
  const projects = useApp(s => s.projects)
  const connected = useApp(s => s.status === 'open')
  const peek = useNav(s => s.pullsPeek)
  const [filter, setFilter] = useState<Filter>('open')
  const [projectId, setProjectId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const [revision, refresh] = useState(0)
  const [loaded, setLoaded] = useState<{ scope: string; rows: Row[]; errors: string[] } | null>(null)
  const [pending, setPending] = useState(false)
  const [selection, setSelection] = useState(lastSelection)
  const search = useRef<PublicInstance | null>(null)
  const [focus, setFocus] = useState<string | null>(null)
  const [windowWidth, setWindowWidth] = useState(() => renderer?.getWindowSize?.().width ?? 1280)
  // Read geometry on user input, with no idle resize polling.
  const measure = () => setWindowWidth(renderer?.getWindowSize?.().width ?? 1280)
  const wide = windowWidth - 60 - (peek ? 256 : 0) >= 832
  const targets = useMemo(() => projects.filter(p => p.is_git && (!projectId || p.id === projectId)), [projects, projectId])
  const scope = `${filter}:${targets.map(p => p.id).join(',')}`
  useEffect(() => {
    if (!connected) return
    let canceled = false
    setPending(true)
    void mapWithConcurrency(targets, 3, async project => {
      if (canceled) return { rows: [] as Row[], error: '' }
      try {
        const key = `${project.id}:${filter}`
        const cached = cache.get(key)
        const prs = revision === 0 && cached && cached.until > Date.now() ? cached.rows : (await getClient()!.call('github.pr.list', { project_id: project.id, state: filter, limit: 30 })).pull_requests
        cache.set(key, { until: Date.now() + 30_000, rows: prs })
        if (cache.size > 100) cache.delete(cache.keys().next().value!)
        return { rows: prs.map(pr => ({ pr, project })), error: '' }
      } catch (e) {
        const message = String(e)
        return { rows: [] as Row[], error: classifyPrError(message) === 'no-remote' ? '' : `${project.name}: ${message}` }
      }
    }).then(results => {
      if (canceled) return
      setLoaded({ scope, rows: results.flatMap(r => r.rows).sort((a, b) => b.pr.updated_at.localeCompare(a.pr.updated_at)), errors: results.map(r => r.error).filter(Boolean) })
      setPending(false)
    }, e => { if (!canceled) { setLoaded({ scope, rows: [], errors: [String(e)] }); setPending(false) } })
    return () => { canceled = true }
  }, [scope, filter, revision, connected])
  const data = loaded?.scope === scope ? loaded : null
  const matching = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase().replace(/^#/, '')
    return (data?.rows ?? []).filter(({ pr }) => !q || pr.title.toLowerCase().includes(q) || pr.head.toLowerCase().includes(q) || String(pr.number).includes(q))
  }, [data, deferredQuery])
  const groups = useMemo(() => {
    const m = new Map<string, Row[]>()
    for (const r of matching) { const group = m.get(r.project.id) ?? []; group.push(r); m.set(r.project.id, group) }
    return [...m.values()]
  }, [matching])
  const flat = groups.flat()
  const open = (r: Row) => { const next = { project: r.project, number: r.pr.number }; lastSelection = next; setSelection(next) }
  const back = () => { lastSelection = null; setSelection(null) }
  useEffect(() => addWindowKeyHandler(e => {
    if (e.modifiers?.cmd && e.key === 'f') { if (!wide) back(); renderer?.focusElement?.(search.current?.id ?? 0); return true }
  }), [renderer, wide])
  const keyFor = (r: Row) => `${r.project.id}:${r.pr.number}`
  const stateWord = filter === 'all' ? '' : `${filter} `
  const failure = data?.errors.find(e => ['gh-missing', 'gh-auth'].includes(classifyPrError(e)))
  return <div testId="page-pulls" onMouseMove={measure} style={{ display: 'flex', flexGrow: 1, minHeight: 0, minWidth: 0 }}>
    {(wide || !selection) && <div style={{ ...column, width: wide ? 352 : '100%', flexShrink: 0, borderRightWidth: wide ? 1 : 0, borderColor: t.border }}>
      <Header title="Pull requests"><Menu testId="pr-project-filter" align="end" width={240} trigger={() => <div style={{display:'flex',alignItems:'center',justifyContent:'center',width:28,height:28}}><Icon source={N.filter} size={16} color={t.textSecondary}/></div>}><MenuItem id="all" label="All projects" checked={!projectId} onSelect={() => setProjectId(null)} />{projects.filter(p => p.is_git).map(p => <MenuItem key={p.id} id={p.id} label={p.name} checked={projectId === p.id} onSelect={() => setProjectId(p.id)} />)}</Menu><div testId="pr-refresh" tabIndex={pending?-1:0} aria-label="Refresh" onClick={()=>{if(!pending)refresh(n=>n+1)}} onKeyDown={e=>{if(!pending&&(e.key==='enter'||e.key==='space'))refresh(n=>n+1)}} style={{display:'flex',alignItems:'center',justifyContent:'center',width:28,height:28,borderRadius:6,hover:{backgroundColor:t.hover}}}><Icon source={N.refresh} size={16} color={t.textSecondary}/></div></Header>
      <div style={{ ...column, gap: 8, padding: 12, paddingBottom: 8 }}><Segments value={filter} options={FILTERS} onChange={v => { setFilter(v); setFocus(null) }} testId="pr-filter" width={[54,72,66,42]} /><input ref={search} testId="pr-search" value={query} placeholder="Search by title, branch or number" onChange={e => setQuery(e.value ?? '')} onKeyDown={e => { if (e.key === 'down' && flat[0]) { setFocus(keyFor(flat[0])); } }} style={{ height: 30, width: '100%', color: t.text, fontSize: 14, borderWidth: 1, borderColor: t.border, backgroundColor: 'transparent', borderRadius: 8, paddingLeft: 9 }} /></div>
      <virtual-list testId="pr-list" estimatedItemHeight={68} style={{ flexGrow: 1, minHeight: 0 }}>
        {failure ? <div key="gh-error" style={{ padding: 20 }}><Problem error={failure} refresh={() => refresh(n => n + 1)} /></div> : !data ? <div key="loading" style={{ padding: 24 }}><Label color={t.textSecondary}>Loading pull requests…</Label></div> : <>
          {data.errors.length > 0 && <div key="errors" style={{ padding: 12 }}><Problem error={data.errors.join('\n')} refresh={() => refresh(n => n + 1)} /></div>}
          {flat.length === 0 && <div key="empty" style={{ ...column, gap: 10, padding: 24, paddingTop: 64 }}><Label color={t.text} size={16} weight={500}>{!targets.length ? 'No GitHub projects' : query.trim() ? `No results for “${query.trim()}”` : `No ${stateWord}pull requests`}</Label><Label color={t.textSecondary} size={13}>{!targets.length ? 'Add a project with a GitHub remote to review its pull requests here.' : query.trim() ? '' : `Pull requests from ${projectId ? targets[0]?.name : 'your GitHub projects'} appear here.`}</Label>{query.trim() ? <Button onClick={() => setQuery('')}>Clear search</Button> : targets.length > 0 && filter !== 'all' && <Button onClick={() => setFilter('all')}>Show all pull requests</Button>}</div>}
          {groups.flatMap(group => [
            ...(groups.length > 1 ? [<div key={`group-${group[0]!.project.id}`} style={{ paddingLeft: 16, paddingTop: 12, paddingBottom: 4 }}><Label color={t.textSecondary} size={11} weight={500}>{group[0]!.project.name}</Label></div>] : []),
            ...group.map(r => <PrRow key={keyFor(r)} item={r} selected={selection?.project.id === r.project.id && selection.number === r.pr.number} focused={focus === keyFor(r)} onOpen={() => open(r)} onFocus={() => setFocus(keyFor(r))} onKey={key => {
              const at = flat.findIndex(x => keyFor(x) === keyFor(r))
              const next = key === 'down' ? Math.min(flat.length - 1, at + 1) : key === 'up' ? Math.max(0, at - 1) : key === 'home' ? 0 : key === 'end' ? flat.length - 1 : -1
              if (next >= 0) setFocus(keyFor(flat[next]!))
            }} />),
          ])}
        </>}
      </virtual-list>
    </div>}
    {selection ? <Detail key={`${selection.project.id}:${selection.number}`} project={selection.project} number={selection.number} onBack={back} width={windowWidth - 60 - (peek ? 256 : 0) - (wide ? 352 : 0)} onChanged={() => refresh(n => n + 1)} /> : wide && <div style={{ ...column, flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 }}><Icon source={N.pullRequest} size={24} color={t.textSecondary}/><Label color={t.text} size={16} weight={500}>Select a pull request</Label><Label color={t.textSecondary} size={14} lineHeight={22} style={{maxWidth:300,textAlign:'center'}}>Read its summary, review changes and send findings to an agent.</Label><Label color={t.textSecondary} size={13}>↑ ↓ to move · Enter to open</Label></div>}
  </div>
}

const PrRow = memo(function PrRow({ item: { pr }, selected, focused, onOpen, onFocus, onKey }: { item: Row; selected: boolean; focused: boolean; onOpen: () => void; onFocus: () => void; onKey: (key: string) => void }) {
  const t = useTheme(); const { renderer } = useGpuix(); const ref = useRef<PublicInstance | null>(null)
  useEffect(() => { if (focused && ref.current) renderer?.focusElement?.(ref.current.id) }, [focused, renderer])
  return <div style={{ paddingLeft: 8, paddingRight: 8, paddingBottom: 0 }}><div ref={ref} testId={`pr-row-${pr.number}`} role="button" aria-label={`${pr.title} #${pr.number}`} tabIndex={0} onFocus={onFocus} onClick={onOpen} onKeyDown={e => { if (e.key === 'enter' || e.key === 'space') onOpen(); else onKey(e.key ?? '') }} style={{ ...column, gap: 4, paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, borderRadius: 8, backgroundColor: selected || focused ? ink(t, .07) : 'transparent', hover: { backgroundColor: t.hover } }}><Label color={t.text} size={15} weight={500} lineHeight={20.625}>{pr.title}</Label><div style={{ ...row, gap: 6 }}><Icon source={N.pullRequest} size={14} color={pr.state === 'MERGED' ? t.link : pr.state === 'OPEN' && !pr.is_draft ? t.green : t.textSecondary}/><div style={{display:'flex',alignItems:'center',justifyContent:'center',width:16,height:16,borderWidth:1,borderColor:t.border,borderRadius:8}}><Label color={t.textSecondary} size={10}>{pr.author.slice(0,1).toUpperCase()}</Label></div><Label color={t.textSecondary} size={13} lineHeight={19.5} truncate style={{ flexGrow: 1 }}>{`${pr.author} · ${relativeTime(pr.updated_at)}`}</Label>{pr.checks_summary && pr.checks_summary.total > 0 && <div style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: pr.checks_summary.failed ? t.red : pr.checks_summary.pending ? t.warning : t.green }} />}<Label color={t.green} size={13} lineHeight={19.5}>{`+${pr.additions}`}</Label><Label color={t.red} size={13} lineHeight={19.5}>{`−${pr.deletions}`}</Label><Label color={t.textSecondary} size={13} lineHeight={19.5}>{`#${pr.number}`}</Label></div></div></div>
})

onEnvironmentChange(() => { cache.clear(); lastSelection = null })
