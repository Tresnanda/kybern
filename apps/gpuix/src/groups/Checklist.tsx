// The repository checklist of the group sheet and of "Add repositories…" (L3 sheets 2 and 3F): a well of rows, nothing
// ticked until the user ticks it. The whole row is the hit area; submodules are listed, dimmed and not selectable; a
// repository found by "Add folder…" rises in already ticked with an "Added" tag. While the daemon scans, three skeleton
// rows hold the well's place and the real rows fade in over them (opacity only: they are data, no stagger).
import { memo } from 'react'
import { GROUP_COPY, GROUP_FOLDER_MEMBER, selectedCountLabel } from '../../../../packages/kybern-client/src/groups.ts'
import type { RepoCandidate } from '../../../../packages/kybern-client/src/types.ts'
import { Badge } from '../kit/Badge.tsx'
import { Checkbox } from '../kit/Checkbox.tsx'
import { RADIUS, useControls } from '../kit/controls.ts'
import { Skeleton } from '../kit/Skeleton.tsx'
import { Icon } from '../icons.tsx'
import { DURATION, EASE, Rise } from '../motion/kit.tsx'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { N } from '../nav/glyphs.ts'
import { FONT_MONO } from '../theme.ts'
import { Label, useTheme } from '../ui.tsx'
import { candidatePathHint, isSelectable } from './model.ts'

const ROW = 32

/** "Repositories" over the well, with the running count on the right (it changes on every tick, so it never animates). */
export function ChecklistHeader({ selected, total }: { selected: number; total: number | null }) {
  const t = useTheme()
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', paddingLeft: 2, paddingRight: 2 }}>
      <Label color={t.textSecondary} size={13} lineHeight={18} weight={500}>{GROUP_COPY.repositories}</Label>
      {total !== null && <Label color={t.textTertiary} size={12} lineHeight={16}>{selectedCountLabel(selected, total)}</Label>}
    </div>
  )
}

export function Checklist({ candidates, selected, onToggle, loading, empty, maxHeight = 336, testId = 'group-checklist' }: {
  candidates: RepoCandidate[]
  selected: readonly string[]
  onToggle: (path: string) => void
  loading: boolean
  /** Shown in place of rows when the scan found nothing selectable. */
  empty?: { title: string; body: string }
  /** The well scrolls past this height, so a folder with many repositories keeps the sheet's buttons on screen. */
  maxHeight?: number
  testId?: string
}) {
  const t = useTheme()
  const c = useControls()
  const well = { display: 'flex', flexDirection: 'column', gap: 2, padding: 4, borderRadius: RADIUS.lg, borderWidth: 1, borderColor: t.borderLight, backgroundColor: c.ink(0.015) } as const
  if (loading)
    return (
      <div testId={`${testId}-loading`} style={well}>
        {[42, 30, 48].map((width, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, height: ROW, paddingLeft: 8, paddingRight: 10 }}>
            <Checkbox disabled aria-label="Loading" style={{ pointerEvents: 'none' }} />
            <Skeleton width={`${width}%`} height={8} radius={4} />
            <div style={{ flexGrow: 1 }} />
            <Skeleton width={44} height={8} radius={4} />
          </div>
        ))}
      </div>
    )
  if (candidates.length === 0 && empty)
    return (
      <div testId={`${testId}-empty`} style={{ ...well, alignItems: 'center', gap: 4, paddingTop: 18, paddingBottom: 18, paddingLeft: 24, paddingRight: 24 }}>
        <Label color={t.text} size={13} lineHeight={18} weight={500}>{empty.title}</Label>
        <Label color={t.textSecondary} size={12} lineHeight={17} style={{ textAlign: 'center' }}>{empty.body}</Label>
      </div>
    )
  return (
    <div testId={testId} paintTransform={PATCHED_NATIVE ? { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: DURATION.quick, ease: [...EASE.out] } } : undefined} style={{ ...well, maxHeight, overflowY: 'scroll' }}>
      {candidates.map((candidate) => (
        <Rise key={candidate.path} play={!!candidate.added} kind="row">
          <CandidateRow candidate={candidate} checked={selected.includes(candidate.path)} onToggle={onToggle} />
        </Rise>
      ))}
    </div>
  )
}

const CandidateRow = memo(function CandidateRow({ candidate, checked, onToggle }: { candidate: RepoCandidate; checked: boolean; onToggle: (path: string) => void }) {
  const t = useTheme()
  const c = useControls()
  const selectable = isSelectable(candidate)
  const hint = candidate.path === GROUP_FOLDER_MEMBER ? GROUP_COPY.groupFolderItself : candidatePathHint(candidate)
  const toggle = () => { if (selectable) onToggle(candidate.path) }
  return (
    <div
      testId={`group-candidate-${candidate.path}`}
      role="checkbox"
      aria-checked={checked}
      aria-label={candidate.name}
      aria-disabled={!selectable || undefined}
      tabIndex={selectable ? 0 : -1}
      onClick={toggle}
      onKeyDown={(e) => { if (e.key === 'enter' || e.key === 'space') toggle() }}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, height: ROW, paddingLeft: 8, paddingRight: 10, borderRadius: RADIUS.sm,
        cursor: selectable ? 'pointer' : 'default',
        ...(selectable ? { hover: { backgroundColor: c.ink(0.04) }, focusVisible: { outlineWidth: 2, outlineColor: c.focus, outlineOffset: -2 } } : {}),
      }}
    >
      <Checkbox checked={checked} disabled={!selectable} aria-label={candidate.name} style={{ pointerEvents: 'none' }} />
      {candidate.path === GROUP_FOLDER_MEMBER && <Icon source={N.folders} size={14} color={t.textSecondary} />}
      <Label color={selectable ? t.text : t.textTertiary} size={13} lineHeight={18} weight={500} truncate style={{ flexShrink: 0, maxWidth: '45%' }}>{candidate.name}</Label>
      {hint && <Label color={t.textTertiary} size={11.5} lineHeight={16} font={FONT_MONO} truncate style={{ flexShrink: 1 }}>{hint}</Label>}
      <div style={{ flexGrow: 1 }} />
      {candidate.added && <Badge variant="info" size="sm">{GROUP_COPY.added}</Badge>}
      {candidate.submodule_of ? (
        <Badge variant="secondary" size="sm">{GROUP_COPY.submoduleOf(candidate.submodule_of)}</Badge>
      ) : candidate.branch ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, maxWidth: 140 }}>
          <Icon source={N.branch} size={12} color={t.textTertiary} />
          <Label color={t.textTertiary} size={12} lineHeight={16} font={candidate.detached ? FONT_MONO : undefined} truncate>{candidate.branch}</Label>
        </div>
      ) : null}
    </div>
  )
})
