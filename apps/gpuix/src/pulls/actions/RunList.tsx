// The run list of the Actions tab, grouped by branch (ADE-97, "C · Pipeline"): the default branch pinned on top as a card with
// a bead string per workflow (release tags included), then "Branches", latest push first, each with its pull request, its latest
// run's state, time and title, and a bead string per workflow. A branch opens its latest run; a bead opens its own run.
// Rows are memoized on their group's beads, so a 10 s refresh re-renders only the groups whose runs changed.
import { memo, useCallback } from 'react'
import { isActive, runWord } from '../../../../../packages/kybern-client/src/actions.ts'
import type { BeadRow, BranchGroup } from '../../../../../packages/kybern-client/src/actionsPipeline.ts'
import { sameRow } from '../../../../../packages/kybern-client/src/actionsPipeline.ts'
import { relativeTime } from '@/lib/format'
import { Icon } from '../../icons.tsx'
import { RADIUS } from '../../kit/controls.ts'
import { toneColor } from '../../kit/tone.ts'
import { N } from '../../nav/glyphs.ts'
import { ink, Label, useTheme } from '../../ui.tsx'
import { column, row } from '../../usage/controls.tsx'
import { BeadString, innerClicked, noteInnerClick } from './Beads.tsx'
import { RunGlyph } from './glyph.tsx'
import { LiveClock } from './LiveClock.tsx'

/** Whether two groups draw the same: same rows of the same beads, same latest run state, PR and selection. */
function sameGroup(a: BranchGroup, b: BranchGroup): boolean {
  return a.branch === b.branch && a.pull?.number === b.pull?.number && a.latest.id === b.latest.id && a.latest.status === b.latest.status
    && a.latest.conclusion === b.latest.conclusion && a.latest.title === b.latest.title && a.latest.attempt === b.latest.attempt
    && a.rows.length === b.rows.length && a.rows.every((r, i) => sameRow(r, b.rows[i]!))
}
const selectedIn = (r: BeadRow, selected: number | null) => selected !== null && r.beads.some(b => b.runId === selected) ? selected : null
const groupHas = (g: BranchGroup, selected: number | null) => selected !== null && (g.latest.id === selected || g.rows.some(r => r.beads.some(b => b.runId === selected)))

/** The latest run's mark and time: a ticking amber clock while it runs, else how long ago it started. */
function LatestState({ group, testId }: { group: BranchGroup; testId: string }) {
  const t = useTheme()
  const run = group.latest
  const running = isActive(run)
  return <div testId={testId} aria-label={runWord(run)} style={{ ...row, gap: 5, flexShrink: 0 }}>
    <RunGlyph item={run} size={13} />
    {running
      ? <LiveClock since={run.started_at ?? run.created_at} format="clock" color={toneColor(t, 'warning')} size={12} />
      : <Label color={t.textTertiary} size={12} lineHeight={16}>{relativeTime(run.created_at)}</Label>}
  </div>
}

/** A workflow, its beads and the latest run's number (or tag). */
function WorkflowRow({ r, selected, onOpen, labelWidth }: { r: BeadRow; selected: number | null; onOpen: (id: number) => void; labelWidth: number }) {
  const t = useTheme()
  return <div style={{ ...row, gap: 8, height: 22 }}>
    <div role="button" tabIndex={-1} testId={`actions-workflow-row-${r.workflowId}`} onClick={() => { noteInnerClick(); onOpen(r.latest.id) }} style={{ width: labelWidth, flexShrink: 0, display: 'flex', cursor: 'pointer' }}>
      <Label color={t.textSecondary} size={12.5} lineHeight={16} truncate>{r.workflow}</Label>
    </div>
    <div style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, display: 'flex' }}>
      <BeadString row={r} selected={selectedIn(r, selected)} onOpen={onOpen} />
    </div>
    <Label color={t.textTertiary} size={12} lineHeight={16} style={{ flexShrink: 0, maxWidth: 72 }} truncate>{r.label}</Label>
  </div>
}

/** The default branch's card. */
export const DefaultCard = memo(function DefaultCard({ group, selected, onOpen }: { group: BranchGroup; selected: number | null; onOpen: (id: number) => void }) {
  const t = useTheme()
  return <div style={{ display: 'flex', paddingLeft: 12, paddingRight: 12, paddingBottom: 6 }}>
    <div testId="actions-default-branch" style={{ ...column, flexGrow: 1, gap: 4, paddingLeft: 12, paddingRight: 12, paddingTop: 9, paddingBottom: 8, borderRadius: RADIUS.xl, borderWidth: 1, borderColor: t.cardEdge, backgroundColor: ink(t, t.variant === 'dark' ? .035 : .025) }}>
      <div role="button" tabIndex={0} aria-label={`${group.branch}, default branch, ${runWord(group.latest)}`} onClick={() => { if (!innerClicked()) onOpen(group.latest.id) }}
        onKeyDown={e => { if (e.key === 'enter' || e.key === 'space') onOpen(group.latest.id) }} style={{ ...row, gap: 6, height: 22, cursor: 'pointer' }}>
        <Icon source={N.branch} size={12} color={t.textTertiary} style={{ flexShrink: 0 }} />
        <Label color={t.text} size={13} lineHeight={18} weight={600} truncate style={{ flexShrink: 1 }}>{group.branch}</Label>
        <Label color={t.textTertiary} size={12} lineHeight={18} style={{ flexShrink: 0 }}>default branch</Label>
        <div style={{ flexGrow: 1 }} />
        <LatestState group={group} testId="actions-default-latest" />
      </div>
      {group.rows.map(r => <WorkflowRow key={r.workflowId} r={r} selected={selected} onOpen={onOpen} labelWidth={84} />)}
    </div>
  </div>
}, (a, b) => a.onOpen === b.onOpen && sameGroup(a.group, b.group) && (a.selected === b.selected || (!groupHas(a.group, a.selected) && !groupHas(b.group, b.selected))))

/** One branch: name and pull request, latest state, latest title, then its workflows. */
export const BranchItem = memo(function BranchItem({ group, selected, last, onOpen }: { group: BranchGroup; selected: number | null; last: boolean; onOpen: (id: number) => void }) {
  const t = useTheme()
  const on = groupHas(group, selected)
  const open = useCallback(() => { if (!innerClicked()) onOpen(group.latest.id) }, [onOpen, group.latest.id])
  return <div style={{ display: 'flex', position: 'relative', paddingLeft: 8, paddingRight: 8 }}>
    <div testId={`actions-branch-${group.branch}`} role="button" tabIndex={0} aria-current={on ? 'true' : undefined}
      aria-label={`${group.branch}${group.pull ? `, pull request ${group.pull.number}` : ''}, ${runWord(group.latest)}`}
      onClick={open} onKeyDown={e => { if (e.key === 'enter' || e.key === 'space') open() }}
      style={{ ...column, flexGrow: 1, gap: 3, paddingLeft: 12, paddingRight: 12, paddingTop: 9, paddingBottom: 10, borderRadius: RADIUS.lg, backgroundColor: on ? ink(t, .06) : 'transparent', hover: { backgroundColor: on ? ink(t, .06) : t.hover } }}>
      <div style={{ ...row, gap: 6, height: 20 }}>
        <Icon source={N.branch} size={12} color={t.textTertiary} style={{ flexShrink: 0 }} />
        <Label color={t.text} size={13} lineHeight={18} weight={600} truncate style={{ flexShrink: 1 }}>{group.branch}</Label>
        {group.pull && <Label color={t.textTertiary} size={12} lineHeight={18} style={{ flexShrink: 0 }}>{`#${group.pull.number}`}</Label>}
        <div style={{ flexGrow: 1 }} />
        <LatestState group={group} testId={`actions-branch-latest-${group.branch}`} />
      </div>
      <div style={{ display: 'flex', paddingLeft: 18 }}>
        <Label color={t.textSecondary} size={13} lineHeight={18} truncate>{group.latest.title || group.latest.workflow_name}</Label>
      </div>
      <div style={{ ...column, paddingLeft: 18, paddingTop: 3 }}>
        {group.rows.map(r => <WorkflowRow key={r.workflowId} r={r} selected={selected} onOpen={onOpen} labelWidth={60} />)}
      </div>
    </div>
    {/* A hairline between branches, inset to the text, hidden under a selected or hovered neighbour's fill. */}
    {!last && <div style={{ position: 'absolute', left: 20, right: 20, bottom: 0, height: 1, backgroundColor: on ? 'transparent' : t.surfaceDivider }} />}
  </div>
}, (a, b) => a.onOpen === b.onOpen && a.last === b.last && sameGroup(a.group, b.group) && (a.selected === b.selected || (!groupHas(a.group, a.selected) && !groupHas(b.group, b.selected))))

/** "Branches N" over the list, "Latest push first" opposite. */
export function BranchesHeading({ count }: { count: number }) {
  const t = useTheme()
  return <div style={{ ...row, gap: 6, paddingLeft: 20, paddingRight: 20, paddingTop: 12, paddingBottom: 4 }}>
    <Label color={t.textTertiary} size={12} lineHeight={16} weight={500}>Branches</Label>
    <Label color={t.textTertiary} size={12} lineHeight={16}>{String(count)}</Label>
    <div style={{ flexGrow: 1 }} />
    <Label color={t.textTertiary} size={12} lineHeight={16}>Latest push first</Label>
  </div>
}
