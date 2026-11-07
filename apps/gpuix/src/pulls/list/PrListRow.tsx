import { useGpuix, type PublicInstance } from '@gpuix/react'
import { memo, useEffect, useRef, useState } from 'react'
import { relativeTime } from '@/lib/format'
import { rowReason } from '../../../../../packages/kybern-client/src/pullRequests.ts'
import { ContextMenu, Menu, MenuItem } from '../../nav/overlay.tsx'
import { IconButton } from '../../kit/IconButton.tsx'
import { isPrimary } from '../../platform/keys.ts'
import { N } from '../../nav/glyphs.ts'
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
export const PrListRow = memo(function PrListRow({ item: { pr, project }, selected, focused, onOpen, onFocus, onKey, onOpenInTab }: { onOpenInTab?: () => void; item: Row; selected: boolean; focused: boolean; onOpen: () => void; onFocus: () => void; onKey: (key: string) => void }) {
  const t = useTheme(); const { renderer } = useGpuix(); const ref = useRef<PublicInstance | null>(null)
  useEffect(() => { if (focused && ref.current) renderer?.focusElement?.(ref.current.id) }, [focused, renderer])
  const [hovered, setHovered] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  const showActions = !!onOpenInTab && (hovered || focused || selected || menuOpen || at !== null)
  const openTabItem = onOpenInTab && <MenuItem id="open-tab" testId="pr-row-open-tab" label="Open in tab" onSelect={onOpenInTab} />
  const reason = rowReason(pr)
  const repo = memberName(project, pr.repo)
  const badge = repo ?? project.name
  return <div onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} style={{ display: 'flex', position: 'relative', alignItems: 'center', paddingLeft: 8, paddingRight: 8 }}>
    <HoverCard testId="pr-card-row" side="right" align="start" sideOffset={10} rootStyle={{ flexGrow: 1 }} style={{ padding: 10, gap: 2, maxWidth: 320 }} trigger={
      <div ref={ref} testId={pr.repo ? `pr-row-${pr.repo}-${pr.number}` : `pr-row-${pr.number}`} role="button" aria-current={selected ? 'page' : undefined} aria-label={`${repo ? `${repo}: ` : ''}${pr.title} #${pr.number}, ${reason.label}`} tabIndex={0} onFocus={onFocus} onClick={e => { if (onOpenInTab && isPrimary(e.modifiers)) onOpenInTab(); else onOpen() }}
        onAuxClick={e => { if (onOpenInTab && (e.isRightClick || e.button === 2)) setAt({ x: e.x ?? 0, y: e.y ?? 0 }) }} onKeyDown={e => { if (e.key === 'enter' || e.key === 'space') onOpen(); else onKey(e.key ?? '') }}
        style={{ ...column, flexGrow: 1, gap: 5, paddingLeft: 10, paddingRight: 10, paddingTop: 8, paddingBottom: 9, borderRadius: RADIUS.md, backgroundColor: selected ? ink(t, .07) : hovered ? t.hover : 'transparent', hover: { backgroundColor: selected ? ink(t, .07) : t.hover } }}>
        <div style={{ ...row, alignItems: 'flex-start', gap: 8 }}>
          <Label color={t.text} size={13} lineHeight={18} weight={500} style={{ flexGrow: 1, minWidth: 0, lineClamp: 2, textOverflow: 'ellipsis' }}>{pr.title}</Label>
          <div style={{ flexShrink: 0, minWidth: onOpenInTab ? 24 : undefined, height: 18 }}>
            <Label color={t.textTertiary} size={12} lineHeight={18} style={{ opacity: showActions ? 0 : 1 }}>{`#${pr.number}`}</Label>
          </div>
        </div>
        <div style={{ ...row, gap: 6 }}>
          <RepoBadge testId="pr-badge-repo" name={badge} projectId={project.id} {...(pr.repo ? { repo: pr.repo } : {})} />
          <Reason testId="pr-badge-reason" reason={reason} />
          <DiffStat additions={pr.additions} deletions={pr.deletions} />
        </div>
      </div>
    }>
      <Label color={t.textTertiary} size={12} lineHeight={16}>{`#${pr.number}`}</Label>
      <Label color={t.text} size={13} lineHeight={18} weight={500}>{pr.author || 'Unknown author'}</Label>
      <Label color={t.textSecondary} size={12} lineHeight={16}>{`${pr.head} → ${pr.base}`}</Label>
      <Label color={t.textTertiary} size={12} lineHeight={16}>{`Updated ${relativeTime(pr.updated_at)}`}</Label>
    </HoverCard>
    {/* A sibling overlay avoids bubbling the menu click into row selection. */}
    {showActions && <Menu align="end" onOpenChange={setMenuOpen} rootStyle={{ position: 'absolute', right: 18, top: 5 }} testId={`pr-row-menu-${pr.repo ?? 'single'}-${pr.number}`} trigger={() => <IconButton testId={`pr-row-more-${pr.repo ?? 'single'}-${pr.number}`} icon={N.ellipsis} size="sm" label="Pull request actions" />}>
      {openTabItem}
    </Menu>}
    {at && <ContextMenu at={at} onClose={() => setAt(null)} testId={`pr-row-context-${pr.repo ?? 'single'}-${pr.number}`}>
      {openTabItem}
    </ContextMenu>}
  </div>
})
