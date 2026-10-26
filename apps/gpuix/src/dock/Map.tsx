// The Coordinator's project map, read-only: the daemon-built description of the repositories (`projects.map`), stamped with the
// commit it describes. Layout, Commands, Busy areas and Removed and renamed, one virtual list; a path row shows that path in
// Explorer. The header's rebuild button asks for the map again (the daemon rebuilds when a repository's HEAD moved).
import path from 'node:path'
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import type { ProjectMap, ProjectMapRepo, Thread } from '../../../../packages/kybern-client/src/types.ts'
import { builtAgo, changeRow, mapHead, NOTES_HISTORY_COPY as COPY } from '../../../../packages/kybern-client/src/notesHistory.ts'
import { errorText } from '../nav/actions.ts'
import { IconButton } from '../kit/IconButton.tsx'
import { Tip } from '../nav/overlay.tsx'
import { SwapOnChange } from '../motion/kit.tsx'
import { Spinner } from '../kit/Spinner.tsx'
import { LimitFill } from '../usage/AccountMark.tsx'
import { getClient, useApp } from '../state.ts'
import { FONT_MONO } from '../theme.ts'
import { ink, Label, useTheme } from '../ui.tsx'
import { TaskWindow, type TaskWindowEntry } from '../tasks/TaskWindow.tsx'
import { DOCK_ICONS } from './icons.ts'
import { canShowFileInExplorer, showFileInExplorer } from './explorerSelection.ts'
import { DockSection, ScopeHeader } from './Notes.tsx'
import { DockEmpty, ErrorLine, Section } from './parts.tsx'
import { muted } from '../nav/overlay.tsx'

const ROW = 28

export function MapPane({ thread }: { thread: Thread }) {
  const projectId = thread.coordinator_project_id!
  const project = useApp((s) => s.projects.find((p) => p.id === projectId))
  const [map, setMap] = useState<ProjectMap | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const request = useRef(0)
  const load = useCallback(async () => {
    const mine = ++request.current
    setLoading(true); setError(null)
    try {
      const result = await getClient()!.call('projects.map', { project_id: projectId })
      if (mine === request.current) setMap(result.map)
    } catch (e) { if (mine === request.current) setError(errorText(e)) } finally { if (mine === request.current) setLoading(false) }
  }, [projectId])
  useEffect(() => { void load(); return () => { request.current++ } }, [load])
  const reveal = (repo: ProjectMapRepo | undefined, rel: string) => {
    if (!project || !canShowFileInExplorer(thread.id, thread.project_id, absolute(project.path, repo, rel))) return
    showFileInExplorer(thread.id, thread.project_id, absolute(project.path, repo, rel))
  }
  const canReveal = (repo: ProjectMapRepo | undefined, rel: string) => !!project && canShowFileInExplorer(thread.id, thread.project_id, absolute(project.path, repo, rel))
  const entries = map ? mapEntries(map, reveal, canReveal) : []
  return <div testId="dock-map" style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0 }}>
    <ScopeHeader thread={thread} action={<Tip label={COPY.mapRebuild} side="top" size={24}><IconButton icon={DOCK_ICONS.refresh} size="sm" glyph={14} label={COPY.mapRebuild} testId="dock-map-rebuild" disabled={loading} onClick={() => void load()}>{loading && !map ? <Spinner size={12} /> : undefined}</IconButton></Tip>} />
    {map && <AsOf map={map} />}
    <ErrorLine error={error} retry={() => void load()} />
    {!map && !error ? (loading ? <Section label="Loading map…" /> : null)
      : map && !entries.length ? <DockEmpty icon={DOCK_ICONS.map} title={COPY.mapEmptyTitle} body={COPY.mapEmptyBody} />
      : map ? <TaskWindow entries={entries} testId="dock-map-list" /> : null}
  </div>
}

function absolute(projectPath: string, repo: ProjectMapRepo | undefined, rel: string) {
  return path.join(projectPath, repo && repo.path !== '.' ? repo.path : '', rel === '.' ? '' : rel)
}

/** "As of def5678 on main · built from git 2 min ago". The commit swaps when a rebuild lands on another HEAD. */
function AsOf({ map }: { map: ProjectMap }) {
  const t = useTheme()
  const head = mapHead(map)
  if (!head) return null
  return <div testId="dock-map-asof" style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4, paddingLeft: 14, paddingRight: 14, paddingBottom: 8, flexShrink: 0 }}>
    <Label color={muted(t, 0.6)} size={13} lineHeight={19.5}>As of</Label>
    <SwapOnChange active={head.sha} style={{ justifyContent: 'flex-start' }}><Mono bg>{head.sha}</Mono></SwapOnChange>
    {head.branch && <Label color={muted(t, 0.6)} size={13} lineHeight={19.5}>{`on ${head.branch}`}</Label>}
    <Label color={muted(t, 0.45)} size={13} lineHeight={19.5}>{`· built from git ${builtAgo(map.built_at, Date.now())}`}</Label>
  </div>
}

function Mono({ children, bg = false, color, truncate = false }: { children: string; bg?: boolean; color?: string; truncate?: boolean }) {
  const t = useTheme()
  const label = <Label color={color ?? muted(t, 0.8)} size={12} lineHeight={18} font={FONT_MONO} truncate={truncate} style={truncate ? { flexShrink: 1, minWidth: 0 } : undefined}>{children}</Label>
  return bg ? <div style={{ display: 'flex', alignItems: 'center', paddingLeft: 5, paddingRight: 5, borderRadius: 4, backgroundColor: ink(t, 0.06) }}>{label}</div> : label
}

function mapEntries(map: ProjectMap, reveal: (repo: ProjectMapRepo | undefined, rel: string) => void, canReveal: (repo: ProjectMapRepo | undefined, rel: string) => boolean): TaskWindowEntry[] {
  const out: TaskWindowEntry[] = []
  const repoOf = (name: string) => map.repos.find((r) => r.path === name || r.name === name)
  // Rows of a project with several repositories carry the repository's name before the path.
  const many = map.repos.length > 1
  const prefix = (repo: string, rel: string) => many ? `${repo}/${rel}` : rel
  const section = (key: string, label: string, meta?: string) => { const lead = out.length === 0; out.push({ key: `section:${key}`, height: lead ? 28 : 36, render: () => <div style={{ paddingTop: lead ? 0 : 8 }}><DockSection label={label}>{meta && <MapMeta>{meta}</MapMeta>}</DockSection></div> }) }
  if (map.layout.length) {
    section('layout', COPY.mapLayout)
    map.layout.forEach((area, i) => out.push({ key: `layout:${i}`, height: ROW, render: () => <PathRow path={prefix(area.repo, area.path)} detail={area.name ?? area.manifest ?? ''} count={area.files} onOpen={canReveal(repoOf(area.repo), area.path) ? () => reveal(repoOf(area.repo), area.path) : undefined} /> }))
  }
  if (map.commands.length) {
    section('commands', COPY.mapCommands)
    map.commands.forEach((command, i) => out.push({ key: `command:${i}`, height: ROW, render: () => <PathRow path={command.name} detail={command.run} source={prefix(command.repo, command.source)} onOpen={canReveal(repoOf(command.repo), command.source) ? () => reveal(repoOf(command.repo), command.source) : undefined} /> }))
  }
  if (map.busy.length) {
    const peak = Math.max(...map.busy.map((b) => b.commits), 1)
    section('busy', COPY.mapBusy, COPY.mapBusyMeta)
    map.busy.forEach((busy, i) => out.push({ key: `busy:${i}`, height: ROW, render: () => <BusyRow index={i} path={prefix(busy.repo, busy.path)} commits={busy.commits} share={busy.commits / peak} onOpen={canReveal(repoOf(busy.repo), busy.path) ? () => reveal(repoOf(busy.repo), busy.path) : undefined} /> }))
  }
  if (map.removed.length) {
    section('removed', COPY.mapRemoved, COPY.mapRemovedMeta)
    map.removed.forEach((change, i) => { const row = changeRow(change); out.push({ key: `removed:${i}`, height: ROW, render: () => <ChangeRow status={row.status} path={prefix(change.repo, row.path)} commit={row.commit} date={row.date} onOpen={change.kind === 'renamed' && canReveal(repoOf(change.repo), change.path) ? () => reveal(repoOf(change.repo), change.path) : undefined} /> }) })
  }
  return out
}

function MapMeta({ children }: { children: string }) {
  const t = useTheme()
  return <Label color={muted(t, 0.4)} size={12}>{children}</Label>
}

/** One 28-high row: hover fill and a pointer only when it opens something. */
function RowShell({ onOpen, testId, children }: { onOpen?: () => void; testId?: string; children: React.ReactNode }) {
  const t = useTheme()
  return <div testId={testId} role={onOpen ? 'button' : undefined} tabIndex={onOpen ? 0 : -1} onClick={onOpen} onKeyDown={onOpen ? (e) => { if (e.key === 'enter') onOpen() } : undefined}
    style={{ display: 'flex', alignItems: 'center', gap: 10, height: ROW, marginLeft: 6, marginRight: 6, paddingLeft: 8, paddingRight: 8, borderRadius: 6, cursor: onOpen ? 'pointer' : 'default', ...(onOpen ? { hover: { backgroundColor: t.hover } } : {}) }}>{children}</div>
}

const PathRow = memo(function PathRow({ path: rel, detail, count, source, onOpen }: { path: string; detail?: string; count?: number; source?: string; onOpen?: () => void }) {
  const t = useTheme()
  return <RowShell onOpen={onOpen}>
    <div style={{ display: 'flex', flexShrink: 0, maxWidth: '55%', pointerEvents: 'none' }}><Mono truncate color={t.text}>{rel}</Mono></div>
    <Label color={muted(t, 0.55)} size={13} lineHeight={19.5} truncate style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, pointerEvents: 'none' }}>{detail ?? ''}</Label>
    {count !== undefined && <Label color={muted(t, 0.45)} size={12} style={{ fontVariantNumeric: 'tabular-nums', pointerEvents: 'none' } as never}>{String(count)}</Label>}
    {source && <Label color={muted(t, 0.45)} size={12} truncate style={{ flexShrink: 0, maxWidth: 140, pointerEvents: 'none' }}>{source}</Label>}
  </RowShell>
})

/** Commits in 30 days with a 4 px meter: the usage meter's track and neutral fill, scaled to the busiest area. */
const BusyRow = memo(function BusyRow({ index, path: rel, commits, share, onOpen }: { index: number; path: string; commits: number; share: number; onOpen?: () => void }) {
  const t = useTheme()
  return <RowShell onOpen={onOpen} testId={`dock-map-busy-${index}`}>
    <div style={{ display: 'flex', flexGrow: 1, flexShrink: 1, minWidth: 0, pointerEvents: 'none' }}><Mono truncate color={t.text}>{rel}</Mono></div>
    <div style={{ display: 'flex', width: 96, height: 4, flexShrink: 0, borderRadius: 2, overflow: 'hidden', backgroundColor: ink(t, 0.1), pointerEvents: 'none' }}><LimitFill left={Math.round(share * 100)} color={ink(t, 0.65)} /></div>
    <Label color={muted(t, 0.6)} size={12} style={{ width: 22, textAlign: 'right', fontVariantNumeric: 'tabular-nums', pointerEvents: 'none' } as never}>{String(commits)}</Label>
  </RowShell>
})

/** D in red, R in the warning colour, then the path and the commit it happened in. */
const ChangeRow = memo(function ChangeRow({ status, path: rel, commit, date, onOpen }: { status: 'D' | 'R'; path: string; commit: string; date: string; onOpen?: () => void }) {
  const t = useTheme()
  return <RowShell onOpen={onOpen} testId="dock-map-change">
    <Label color={status === 'D' ? t.red : t.warning} size={12} weight={600} style={{ width: 12, textAlign: 'center', flexShrink: 0, pointerEvents: 'none' } as never}>{status}</Label>
    <div style={{ display: 'flex', flexGrow: 1, flexShrink: 1, minWidth: 0, pointerEvents: 'none' }}><Mono truncate color={t.text}>{rel}</Mono></div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, pointerEvents: 'none' }}><Mono color={muted(t, 0.55)}>{commit}</Mono><Label color={muted(t, 0.45)} size={12}>{date}</Label></div>
  </RowShell>
})
