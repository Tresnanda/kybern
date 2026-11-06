// One issue in the Issues list: the title (two lines at most) with its number, then the repository badge, the labels as dots
// with their names, and on the right the pull requests that close it and the author. Shaped like `PrListRow`.
import { useGpuix, type PublicInstance } from '@gpuix/react'
import { memo, useEffect, useRef } from 'react'
import { relativeTime } from '@/lib/format'
import type { Issue } from '../../../../../packages/kybern-client/src/types.ts'
import { Icon } from '../../icons.tsx'
import { Avatar } from '../../kit/Avatar.tsx'
import { RADIUS } from '../../kit/controls.ts'
import { HoverCard } from '../../kit/HoverCard.tsx'
import { LABEL_DOT_GAP, LabelDot } from '../../kit/StatusChip.tsx'
import { N } from '../../nav/glyphs.ts'
import { ink, Label, useTheme } from '../../ui.tsx'
import { column, row } from '../../usage/controls.tsx'
import { labelColor } from '../detail/model.ts'
import { RepoBadge } from '../list/parts.tsx'

/** Labels named on a row; the rest is a count. */
const LABELS_SHOWN = 2

export const IssueRow = memo(function IssueRow({ issue, repoName, projectId, selected, focused, onOpen, onFocus, onKey }: { issue: Issue; repoName: string; projectId: string; selected: boolean; focused: boolean; onOpen: () => void; onFocus: () => void; onKey: (key: string) => void }) {
  const t = useTheme(); const { renderer } = useGpuix(); const ref = useRef<PublicInstance | null>(null)
  useEffect(() => { if (focused && ref.current) renderer?.focusElement?.(ref.current.id) }, [focused, renderer])
  const labels = issue.labels ?? []
  const linked = issue.linked_pull_requests ?? []
  return <div style={{ display: 'flex', alignItems: 'center', paddingLeft: 8, paddingRight: 8 }}>
    <HoverCard testId="issue-card-row" side="right" align="start" sideOffset={10} rootStyle={{ flexGrow: 1 }} style={{ padding: 10, gap: 2, maxWidth: 320 }} trigger={
      <div ref={ref} testId={`issue-row-${issue.number}`} role="button" aria-current={selected ? 'page' : undefined} aria-label={`${issue.title} #${issue.number}`} tabIndex={0} onFocus={onFocus} onClick={onOpen} onKeyDown={e => { if (e.key === 'enter' || e.key === 'space') onOpen(); else onKey(e.key ?? '') }}
        style={{ ...column, flexGrow: 1, gap: 5, paddingLeft: 10, paddingRight: 10, paddingTop: 8, paddingBottom: 9, borderRadius: RADIUS.md, backgroundColor: selected ? ink(t, .07) : 'transparent', hover: { backgroundColor: selected ? ink(t, .07) : t.hover } }}>
        <div style={{ ...row, alignItems: 'flex-start', gap: 8 }}>
          <Label color={t.text} size={13} lineHeight={18} weight={500} style={{ flexGrow: 1, minWidth: 0, lineClamp: 2, textOverflow: 'ellipsis' }}>{issue.title}</Label>
          <Label color={t.textTertiary} size={12} lineHeight={18} style={{ flexShrink: 0 }}>{`#${issue.number}`}</Label>
        </div>
        <div style={{ ...row, gap: 8 }}>
          <RepoBadge testId="issue-badge-repo" name={repoName} projectId={projectId} {...(issue.repo ? { repo: issue.repo } : {})} />
          <div style={{ ...row, gap: 8, flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
            {labels.slice(0, LABELS_SHOWN).map(l => <div key={l.name} testId="issue-label" style={{ ...row, gap: LABEL_DOT_GAP, flexShrink: 1, minWidth: 0 }}>
              <LabelDot color={labelColor(l.color) ?? t.textSecondary} fontSize={12} />
              <Label color={t.textSecondary} size={12} lineHeight={16} truncate>{l.name}</Label>
            </div>)}
            {labels.length > LABELS_SHOWN && <Label color={t.textTertiary} size={12} lineHeight={16} style={{ flexShrink: 0 }}>{`+${labels.length - LABELS_SHOWN}`}</Label>}
          </div>
          {linked.length > 0 && <div testId={`issue-linked-${issue.number}`} style={{ ...row, gap: 3, flexShrink: 0 }}>
            <Icon source={N.pullRequest} size={12} color={t.green} />
            <Label color={t.textSecondary} size={12} lineHeight={16}>{`#${linked[0]}${linked.length > 1 ? ` +${linked.length - 1}` : ''}`}</Label>
          </div>}
          <Avatar login={issue.author} url={issue.author_avatar_url} size={16} />
        </div>
      </div>
    }>
      <Label color={t.text} size={13} lineHeight={18} weight={500}>{issue.author || 'Unknown author'}</Label>
      <Label color={t.textTertiary} size={12} lineHeight={16}>{`Updated ${relativeTime(issue.updated_at)}`}</Label>
    </HoverCard>
  </div>
})
