import { PR_SCROLL_LAYOUT } from './scroll-layout.ts'
import { N } from '../nav/glyphs.ts'
import { FONT_MONO } from '../theme.ts'
import { alpha, cachedMarkdownTheme as markdownTheme } from '../transcript/kit.tsx'
import { Button } from '../kit/Button.tsx'
import { Checkbox } from '../kit/Checkbox.tsx'
import { Segmented } from '../kit/Segmented.tsx'
import { memo, useState } from 'react'
import { toggleReviewFinding } from '@/state/prReviewModel'
import { Icon } from '../icons.tsx'
import { relativeTime } from '@/lib/format'
import type { PrPageKind, PrReviewEntry } from '../../../../packages/kybern-client/src/types.ts'
import { Label, ink, useTheme } from '../ui.tsx'
import { column, row } from '../usage/controls.tsx'
import { openUrl, PrLoading, Problem } from './PrStates.tsx'
import { usePage, type Review } from './useReview.ts'

export { Changes } from './changes/Changes.tsx'

const SOURCES = [['comments', 'Comments'], ['reviews', 'Reviews'], ['review_comments', 'Inline comments']] as const
export function Timeline({ projectId, number, repo, review, onSend }: { projectId: string; number: number; repo?: string; review: Review; onSend: () => void }) {
  const t = useTheme(); const [kind, setKind] = useState<PrPageKind>('comments'); const [page, setPage] = useState(1)
  const { data, error } = usePage(projectId, number, kind, page, review.revision, review.detail?.head_sha, true, repo)
  // Send to agent checks the pull request out into a chat, which member pull requests can't do yet.
  const selectable = !repo
  return <div testId="pr-timeline" style={{ ...column, flexGrow: 1, minHeight: 0 }}><div style={{ ...row, paddingLeft: 24, paddingRight: 24, paddingTop: 12, paddingBottom: 0 }}><Segmented size="sm" aria-label="Timeline source" value={kind} options={SOURCES.map(([value, label]) => ({ value, label }))} onChange={v => { setKind(v as PrPageKind); setPage(1) }} testId="pr-source" /></div>
    {error ? <div style={{ padding: 24 }}><Problem error={error} refresh={review.refresh} /></div> : <virtual-list {...PR_SCROLL_LAYOUT} testId="pr-timeline-entries" estimatedItemHeight={140} style={{ flexGrow: 1, minHeight: 0 }}>
      {!data ? <div key="loading" style={{ padding: 24 }}><PrLoading label="Loading…" rows={5} /></div> : data.entries.length === 0 ? <div key="empty" style={{ padding: 24 }}><Label color={t.textSecondary}>{`No ${SOURCES.find(s => s[0] === kind)?.[1].toLowerCase() ?? 'comments'} on this page.`}</Label></div> : data.entries.map(entry => <Entry key={`${kind}:${entry.id}`} entry={entry} checked={review.draft.selected.includes(`${kind}:${entry.id}`)} onToggle={selectable ? () => review.saveDraft(toggleReviewFinding(review.draft, `${kind}:${entry.id}`, entry)) : undefined} />)}
      <div key="pagination" style={{ ...row, justifyContent: 'space-between', padding: 24 }}><Label color={t.textSecondary} size={13}>{`Page ${page}`}</Label><Pager page={page} more={!!data?.has_more} loading={!data} setPage={setPage} /></div>
    </virtual-list>}
    {selectable && review.draft.selected.length > 0 && <div style={{ ...row, justifyContent: 'center', paddingBottom: 12 }}><Label color={t.text} size={13}>{`${review.draft.selected.length} selected`}</Label><Button variant="ghost" size="sm" onClick={() => review.updateDraft({ selected: [], findings: {} })}>Clear</Button><Button size="sm" icon="bot" onClick={onSend}>Send to agent</Button></div>}
  </div>
}

/** `onToggle` is absent when findings can't be sent (a member pull request of a group project). */
const Entry = memo(function Entry({ entry, checked, onToggle }: { entry: PrReviewEntry; checked: boolean; onToggle?: () => void }) {
  const t = useTheme(); const [open, setOpen] = useState(true); const [clamped, setClamped] = useState(true)
  const body = entry.body || 'No review summary.'; const lines = body.split('\n'); const tall = lines.length > 16
  return <div style={{ paddingLeft: 24, paddingRight: 24 }}><div style={{ ...column, borderBottomWidth: 1, borderColor: t.border, paddingBottom: 12 }}><div style={{ ...row, paddingTop: 10, paddingBottom: 10 }}>{onToggle && <Checkbox testId={`pr-select-${entry.id}`} aria-label="Select for agent" checked={checked} onCheckedChange={() => onToggle()} />}<div role="button" tabIndex={0} aria-expanded={open} onClick={() => setOpen(!open)} onKeyDown={e => { if (e.key === 'enter' || e.key === 'space') setOpen(!open) }} style={{ ...row, flexGrow: 1, cursor: 'pointer' }}><div style={{ ...row, width: 20, height: 20, justifyContent: 'center', borderWidth: 1, borderColor: t.border, borderRadius: 10 }}><Label color={t.textSecondary} size={10} lineHeight={14}>{entry.author.slice(0,1).toUpperCase()}</Label></div><Label color={t.text} size={14} lineHeight={21} weight={500}>{entry.author}</Label>{entry.state && <div style={{ borderRadius: 8, paddingLeft: 8, paddingRight: 8, backgroundColor: entry.state === 'APPROVED' ? alpha(t.green,.12) : ink(t,.07) }}><Label color={entry.state === 'APPROVED' ? t.green : entry.state === 'CHANGES_REQUESTED' ? t.red : t.textSecondary} size={13} lineHeight={18}>{entry.state.toLowerCase().replaceAll('_', ' ').replace(/^./, c => c.toUpperCase())}</Label></div>}<Label color={t.textSecondary} size={13} font={FONT_MONO} truncate style={{ flexGrow: 1 }}>{entry.path ? `${entry.path}:${entry.line ?? 'outdated'}` : ''}</Label><Label color={t.textSecondary} size={13}>{relativeTime(entry.updated_at)}</Label><Icon source={open ? N.chevronDown : N.chevronRight} size={14} color={t.textSecondary} /></div></div>{open && <div style={{ ...column, paddingLeft: 52, gap: 8 }}><markdown source={tall && clamped ? lines.slice(0, 16).join('\n') : body} theme={markdownTheme(t)} onLinkClick={e => e.value && openUrl(e.value)} style={{ userSelect: 'text', color: t.text, fontSize: 15 }} />{tall && <Button variant="ghost" size="sm" style={{ alignSelf: 'flex-start' }} onClick={() => setClamped(!clamped)}>{clamped ? 'Show more' : 'Show less'}</Button>}</div>}</div></div>
})
function Pager({ page, more, loading, setPage }: { page: number; more: boolean; loading: boolean; setPage: (n: number) => void }) { return <div style={row}><Button size="sm" testId="pr-page-previous" disabled={loading || page <= 1} onClick={() => setPage(page - 1)}>Previous page</Button><Button size="sm" testId="pr-page-next" disabled={loading || !more} onClick={() => setPage(page + 1)}>Next page</Button></div> }
