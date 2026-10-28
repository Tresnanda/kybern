import { useGpuix, type PublicInstance } from '@gpuix/react'
import { memo, useEffect, useRef } from 'react'
import { relativeTime } from '@/lib/format'
import { rowReason } from '../../../../../packages/kybern-client/src/pullRequests.ts'
import { RADIUS } from '../../kit/controls.ts'
import { HoverCard } from '../../kit/HoverCard.tsx'
import { ink, Label, useTheme } from '../../ui.tsx'
import { column, row } from '../../usage/controls.tsx'
import { DiffStat, Reason, RepoBadge } from './parts.tsx'
import { memberName, type Row } from './model.ts'

/**
 * One pull request: the title (two lines at most) with its number, then the repository, why it is where it is, and the
 * diff size. The author is not drawn (it is in the tooltip and the detail), so the second line never truncates it away.
 */
export const PrListRow = memo(function PrListRow({ item: { pr, project }, selected, focused, onOpen, onFocus, onKey }: { item: Row; selected: boolean; focused: boolean; onOpen: () => void; onFocus: () => void; onKey: (key: string) => void }) {
  const t = useTheme(); const { renderer } = useGpuix(); const ref = useRef<PublicInstance | null>(null)
  useEffect(() => { if (focused && ref.current) renderer?.focusElement?.(ref.current.id) }, [focused, renderer])
  const reason = rowReason(pr)
  const repo = memberName(project, pr.repo)
  const badge = repo ?? project.name
  return <div style={{ display: 'flex', paddingLeft: 8, paddingRight: 8 }}>
    <HoverCard testId="pr-card-row" side="right" align="start" sideOffset={10} rootStyle={{ flexGrow: 1 }} style={{ padding: 10, gap: 2, maxWidth: 320 }} trigger={
      <div ref={ref} testId={pr.repo ? `pr-row-${pr.repo}-${pr.number}` : `pr-row-${pr.number}`} role="button" aria-current={selected ? 'page' : undefined} aria-label={`${repo ? `${repo}: ` : ''}${pr.title} #${pr.number}, ${reason.label}`} tabIndex={0} onFocus={onFocus} onClick={onOpen} onKeyDown={e => { if (e.key === 'enter' || e.key === 'space') onOpen(); else onKey(e.key ?? '') }}
        style={{ ...column, flexGrow: 1, gap: 5, paddingLeft: 10, paddingRight: 10, paddingTop: 8, paddingBottom: 9, borderRadius: RADIUS.md, backgroundColor: selected ? ink(t, .07) : 'transparent', hover: { backgroundColor: selected ? ink(t, .07) : t.hover } }}>
        <div style={{ ...row, alignItems: 'flex-start', gap: 8 }}>
          <Label color={t.text} size={13} lineHeight={18} weight={500} style={{ flexGrow: 1, minWidth: 0, lineClamp: 2, textOverflow: 'ellipsis' }}>{pr.title}</Label>
          <Label color={t.textTertiary} size={12} lineHeight={18} style={{ flexShrink: 0 }}>{`#${pr.number}`}</Label>
        </div>
        <div style={{ ...row, gap: 6 }}>
          <RepoBadge testId="pr-badge-repo" name={badge} hueKey={`${project.id}/${pr.repo ?? ''}`} />
          <Reason testId="pr-badge-reason" reason={reason} />
          <DiffStat additions={pr.additions} deletions={pr.deletions} />
        </div>
      </div>
    }>
      <Label color={t.text} size={13} lineHeight={18} weight={500}>{pr.author || 'Unknown author'}</Label>
      <Label color={t.textSecondary} size={12} lineHeight={16}>{`${pr.head} → ${pr.base}`}</Label>
      <Label color={t.textTertiary} size={12} lineHeight={16}>{`Updated ${relativeTime(pr.updated_at)}`}</Label>
    </HoverCard>
  </div>
})
