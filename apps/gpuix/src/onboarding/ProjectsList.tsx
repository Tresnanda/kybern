// The scrolling list of the Projects scene: Suggested, then Other projects behind a disclosure, then the hidden-folders note. One
// native virtual list with fixed entry heights (`entriesFor`), so scrolling never measures anything; only the entries in and near
// the viewport carry a React tree, the rest are empty slots of the right height (other projects can be hundreds). Rows keep
// their identity across the ≤4 Hz scan updates, so settled rows are never re-rendered or re-animated.
import { useGpuixRequired, type PublicInstance } from '@gpuix/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '../kit/Button.tsx'
import { Chevron } from '../motion/Chevron.tsx'
import { observeElementBounds } from '../native/layout.ts'
import { EDGE_FADE } from '../native/local-build.ts'
import { pixelWindowRange } from '../sidebar/windowRange.ts'
import { Label, useTheme } from '../ui.tsx'
import { SkeletonRow, ProjectRow } from './ProjectsRow.tsx'
import { ROW_SLOT, entriesFor, hiddenNote, type Entry, type Row } from './projects.ts'
import { selectGroup, shapeOf, toggleOthers, useProjects, type Group } from './projectsStore.ts'

const LIST_ISLAND = { cacheLayout: true, cache: 'fill' as const }

function GroupAction({ group, all, disabled }: { group: Group; all: boolean; disabled: boolean }) {
  return (
    <Button testId={`projects-${group}-all`} variant="ghost" size="sm" swap disabled={disabled} onClick={() => selectGroup(group, !all)}>
      {all ? 'Clear' : 'Select all'}
    </Button>
  )
}

function Head({ title, count, group, all, locked }: { title: string; count: number; group: Group; all: boolean; locked: boolean }) {
  const t = useTheme()
  return (
    <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', height: '100%', paddingLeft: 8, paddingRight: 2 }}>
      <Label color={t.textSecondary} size={12} lineHeight={16} weight={600}>{title}</Label>
      <Label color={t.textTertiary} size={12} lineHeight={16} weight={500} style={{ marginLeft: 6 }}>{String(count)}</Label>
      <div style={{ flexGrow: 1 }} />
      <GroupAction group={group} all={all} disabled={locked} />
    </div>
  )
}

function OthersHead({ count, open, all, locked }: { count: number; open: boolean; all: boolean; locked: boolean }) {
  const t = useTheme()
  return (
    <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', height: '100%', paddingTop: 8, paddingRight: 2 }}>
      <div
        testId="projects-others-toggle"
        role="button"
        aria-expanded={open}
        aria-label={`Other projects, ${count}`}
        tabIndex={0}
        onClick={() => toggleOthers()}
        onKeyDown={(e) => { if (e.key === 'enter' || e.key === 'space') toggleOthers() }}
        style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, height: 28, paddingLeft: 8, paddingRight: 10, borderRadius: 10, cursor: 'pointer', hover: { backgroundColor: t.hover }, focusVisible: { outlineWidth: 2, outlineColor: t.accentBlue, outlineOffset: 0 } }}
      >
        <Chevron open={open} size={14} color={t.textSecondary} />
        <Label color={t.textSecondary} size={12} lineHeight={16} weight={600} style={{ pointerEvents: 'none' }}>Other projects</Label>
        <Label color={t.textTertiary} size={12} lineHeight={16} weight={500} style={{ pointerEvents: 'none' }}>{String(count)}</Label>
      </div>
      <div style={{ flexGrow: 1 }} />
      {open && <GroupAction group="others" all={all} disabled={locked} />}
    </div>
  )
}

export function ProjectsList({ rowWidth }: { rowWidth: number }) {
  const t = useTheme()
  const renderer = useGpuixRequired()
  const suggested = useProjects((s) => s.suggested)
  const others = useProjects((s) => s.others)
  const hidden = useProjects((s) => s.hidden)
  const othersOpen = useProjects((s) => s.othersOpen)
  const status = useProjects((s) => s.status)
  const arrivals = useProjects((s) => s.arrivals)
  const flips = useProjects((s) => s.flips)
  const topGen = useProjects((s) => s.topGen)
  const locked = useProjects((s) => s.job !== null)
  const allSuggested = useProjects((s) => s.suggested.length > 0 && s.suggested.every((r) => s.selected.has(r.root)))
  const allOthers = useProjects((s) => s.others.length > 0 && s.others.every((r) => s.selected.has(r.root)))

  const entries = useMemo(() => entriesFor(shapeOf({ suggested, others, hidden, othersOpen, status })), [suggested, others, hidden, othersOpen, status])
  const byRoot = useMemo(() => new Map<string, Row>([...suggested, ...others].map((r) => [r.root, r])), [suggested, others])
  const ranks = useMemo(() => { const out = new Map<string, number>(); let n = 0; for (const e of entries) if (e.kind === 'row' && e.root) out.set(e.root, n++); return out }, [entries])

  // Which entries carry a React tree: those within a viewport (and a bit) of the logical anchor the native list reports.
  const [box, setBox] = useState<PublicInstance | null>(null)
  const [list, setList] = useState<PublicInstance | null>(null)
  const [viewport, setViewport] = useState(480)
  const [anchor, setAnchor] = useState(0)
  const latest = useRef({ list, count: entries.length })
  latest.current = { list, count: entries.length }
  const sync = useCallback(() => {
    const node = latest.current.list
    if (!node) return
    const top = renderer.getListScrollTop?.(node.id)
    const index = Math.max(0, Math.min(latest.current.count - 1, top?.[0] ?? 0))
    setAnchor((old) => (old === index ? old : index))
  }, [renderer])
  useEffect(() => {
    if (!box) return
    return observeElementBounds(renderer, box.id, ({ rect }) => { if (rect) setViewport(Math.round(rect.height)) })
  }, [renderer, box])
  useEffect(() => {
    if (!list) return
    // A scroll jump can paint only slots; the list's own bounds report it once per frame.
    return observeElementBounds(renderer, list.id, () => sync())
  }, [renderer, list, sync])
  useEffect(() => { sync() }, [sync, entries.length])
  const first = useRef(topGen)
  useEffect(() => {
    if (first.current === topGen) return
    first.current = topGen
    if (!list) return
    // Only when it is not already at the top: on macOS `scrollToItem` refreshes the whole window, which re-renders every island.
    const top = renderer.getListScrollTop?.(list.id)
    if (top && top[0] === 0 && Math.abs(top[1] ?? 0) < 0.5) return
    renderer.scrollToItem?.(list.id, 0)
  }, [topGen, list, renderer])

  const range = pixelWindowRange(entries.length, (i) => entries[i]?.height ?? ROW_SLOT, Math.min(anchor, Math.max(0, entries.length - 1)), 0, viewport, 330)

  const render = (entry: Entry) => {
    switch (entry.kind) {
      case 'skeleton': return <SkeletonRow index={Number(entry.key.split(':')[1])} />
      case 'head': return <Head title="Suggested" count={suggested.length} group="suggested" all={allSuggested} locked={locked} />
      case 'others-head': return <OthersHead count={others.length} open={othersOpen || suggested.length === 0} all={allOthers} locked={locked} />
      case 'row': {
        const row = byRoot.get(entry.root!)
        return row ? <ProjectRow row={row} rank={ranks.get(entry.root!) ?? 0} rowWidth={rowWidth} arrival={arrivals[row.root]} flip={flips[entry.key]} /> : null
      }
      case 'note': return <Label color={t.textTertiary} size={12} lineHeight={16} style={{ paddingLeft: 8, paddingTop: 10 }}>{hiddenNote(hidden)}</Label>
      case 'tail': return null
    }
  }

  return (
    <div
      ref={setBox}
      testId="projects-list-box"
      {...(EDGE_FADE ? { edgeFade: { top: 12, bottom: 36 } } : {})}
      style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0, width: '100%', overflow: 'hidden' }}
    >
      {/* Like the sidebar: the list is one fill island that reuses each unchanged row's layout, so a scene change outside it
          (a count, the toolbar) does not rebuild the rows, and a row that changes lays out alone. */}
      <virtual-list
        {...LIST_ISLAND}
        ref={setList}
        testId="projects-list"
        estimatedItemHeight={ROW_SLOT}
        overdraw={160}
        onVisibleRange={() => sync()}
        style={{ flexGrow: 1, minHeight: 0, width: '100%' }}
      >
        {entries.map((entry, index) => (
          <div key={entry.key} style={{ width: '100%', height: entry.height, flexShrink: 0, paddingLeft: 4, paddingRight: 4 }}>
            {index >= range.start && index < range.end ? render(entry) : null}
          </div>
        ))}
      </virtual-list>
    </div>
  )
}
