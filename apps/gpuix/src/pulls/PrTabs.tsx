import { PR_SCROLL_LAYOUT } from './scroll-layout.ts'
import { LinkSquare02Icon } from '@hugeicons/core-free-icons'
import { glyph, Icon } from '../icons.tsx'
import { N } from '../nav/glyphs.ts'
import { FONT_MONO } from '../theme.ts'
import { alpha, cachedMarkdownTheme as markdownTheme } from '../transcript/kit.tsx'
import { NativeDiffHeader } from '../native/DiffView.tsx'
import { desktopDiffTheme } from '../native/diff.ts'
import { diffFileIcons } from '../native/diff-file-icons.ts'
import { parseUnifiedDiff } from '../../../desktop/src/lib/diff.ts'
import { getFileIconName } from '../../../desktop/src/lib/kit/fileIcons.ts'
import { IconButton } from '../sidebar/rows.tsx'
import { memo, useMemo, useState } from 'react'
import { relativeTime } from '@/lib/format'
import { reviewDraftIsStale, toggleReviewFinding } from '@/state/prReviewModel'
import { prFileUrl } from '@/views/pullRequests/prDiff'
import type { PrPageKind, PrReviewEntry } from '../../../../packages/kybern-client/src/types.ts'
import { Label, ink, useTheme } from '../ui.tsx'
import { Button, Segments, column, row } from '../usage/controls.tsx'
import { openUrl, Problem } from './PrStates.tsx'
import { usePage, type Review } from './useReview.ts'

export function Changes({ projectId, number, review, compact = false }: { projectId: string; number: number; review: Review; compact?: boolean }) {
  const t = useTheme(); const [page, setPage] = useState(1); const [path, setPath] = useState<string | null>(null)
  const { data, error } = usePage(projectId, number, 'files', page, review.revision, review.detail?.head_sha)
  const files = data?.files ?? []
  const file = files.find(f => f.path === path) ?? files[0]
  const patch = useMemo(() => file ? `diff --git a/${file.old_path ?? file.path} b/${file.path}\n--- a/${file.old_path ?? file.path}\n+++ b/${file.path}\n${file.patch}` : '', [file])
  const pending = review.draft.pendingInline
  const stale = review.detail ? reviewDraftIsStale(review.draft, review.detail.head_sha) : false
  const [lineError, setLineError] = useState<string | null>(null)
  const [visibleLines, setVisibleLines] = useState(600)
  // The desktop table sizes its gutters from the currently expanded rows.
  // Native diff knows the full patch, so adjust its digit metric until expanded.
  const diffTheme = useMemo(() => {
    const theme = desktopDiffTheme(t, false)
    const lines = parseUnifiedDiff(patch).flatMap(f => f.hunks.flatMap(h => h.lines))
    const maxNumber = (rows: typeof lines) => rows.reduce((n, l) => Math.max(n, l.oldNo ?? 0, l.newNo ?? 0), 1)
    const digits = String(maxNumber(lines)).length
    const shownDigits = String(maxNumber(lines.slice(0, visibleLines))).length
    if (shownDigits < digits) theme.diff = { ...theme.diff, gutterDigitWidth: 13 * .62415 * shownDigits / digits }
    return theme
  }, [t, patch, visibleLines])
  return <div testId="pr-changes" style={{ ...column, flexGrow: 1, minHeight: 0, paddingTop: 16, paddingBottom: 16, paddingLeft: compact ? 14 : 24, paddingRight: compact ? 14 : 24, gap: 12 }}>
    {error ? <Problem error={error} refresh={review.refresh} /> : <>
      <div style={{ display: 'flex', flexDirection: compact ? 'column' : 'row', flexGrow: 1, minHeight: 0, gap: 16 }}>
        <div style={{ ...column, width: compact ? '100%' : 256, ...(compact ? { height: 208 } : { maxHeight: 574 }), flexShrink: 0, minHeight: 0 }}>
          <div style={{ ...row, paddingLeft: 8, paddingRight: 8, paddingBottom: 4, height: 28, flexShrink: 0 }}><Label color={alpha(t.textSecondary,.8)} size={13} style={{ flexGrow: 1 }}>{files.length ? `${review.detail?.changed_files ?? files.length} files · ${(page - 1) * 30 + 1}–${(page - 1) * 30 + files.length}` : `${review.detail?.changed_files ?? 0} files`}</Label>{([-1, 1] as const).map(step => <div key={step} style={{ opacity: !data || (step < 0 ? page <= 1 : !data.has_more) ? .4 : 1 }}><IconButton testId={step < 0 ? 'pr-page-previous' : 'pr-page-next'} icon={step < 0 ? N.arrowLeft : N.chevronRight} size={24} glyph={14} label={step < 0 ? 'Previous page' : 'Next page'} onClick={() => { if (data && (step < 0 ? page > 1 : data.has_more)) { setPage(page + step); setPath(null); setVisibleLines(600) } }} /></div>)}</div>
          <virtual-list {...PR_SCROLL_LAYOUT} testId="pr-files" estimatedItemHeight={52.5} style={{ flexGrow: 1, minHeight: 0 }}>{files.map((f, i) => <div key={f.path} testId={`pr-file-${i}`} role="button" aria-label={f.path} tabIndex={0} onClick={() => { setPath(f.path); setVisibleLines(600) }} onKeyDown={e => { if (e.key === 'enter' || e.key === 'space') { setPath(f.path); setVisibleLines(600) } }} style={{ ...row, alignItems: 'flex-start', gap: 8, paddingLeft: 8, paddingRight: 8, paddingTop: 6, paddingBottom: 6, borderRadius: 8, backgroundColor: file?.path === f.path ? ink(t, .07) : 'transparent', hover: { backgroundColor: t.hover } }}>
            <Icon source={diffFileIcons[getFileIconName(f.path)] ?? diffFileIcons['code-brackets']!} size={14} color={getFileIconName(f.path) === 'react' ? '#61dafb' : t.textSecondary} />
            <div style={{ ...column, flexGrow: 1, minWidth: 0 }}><Label color={t.text} size={14} lineHeight={21} weight={500} truncate>{f.path.split('/').pop()}</Label><Label color={alpha(t.textSecondary,.8)} size={13} lineHeight={19.5} truncate>{f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/') + 1) : ''}</Label></div>
            <div style={{ ...row, gap: 4 }}><Label color={t.green} size={13}>{`+${f.additions.toLocaleString('en-US')}`}</Label><Label color={t.red} size={13}>{`−${f.deletions.toLocaleString('en-US')}`}</Label>{review.draft.inline.some(c => c.path === f.path) && <Label color={t.link} size={13}>Draft</Label>}</div>
          </div>)}</virtual-list>
        </div>
        <div style={{ ...column, flexGrow: 1, minWidth: 0, minHeight: 0, borderWidth: file ? 1 : 0, borderColor: t.border, borderRadius: 8, overflow: 'hidden' }}>
          {!file ? <Label color={t.textSecondary} size={13}>{data ? 'No changed files on this page.' : 'Loading changes…'}</Label> : <>
            <div style={{ ...row, gap: 0, height: 37, flexShrink: 0, borderBottomWidth: 1, borderColor: t.border, backgroundColor: t.v('--background') }}><div style={{ flexGrow: 1, minWidth: 0 }}><NativeDiffHeader file={file} /></div><IconButton icon={glyph(LinkSquare02Icon)} size={24} glyph={14} label="Open file on GitHub" onClick={() => { if (review.detail) void prFileUrl(review.detail.pull_request.url, file.path).then(openUrl) }} /></div>
            {file.patch ? <diff key={file.path} {...PR_SCROLL_LAYOUT} testId="pr-native-diff" patch={patch} scroll theme={diffTheme} maxLines={visibleLines} onShowMore={() => setVisibleLines(n => n + 600)} onLineClick={e => {
              if (stale) { setLineError('This draft belongs to a different commit. Resolve the previous draft before choosing a new inline anchor.'); return }
              if (pending?.body.trim()) { setLineError('Add this comment to the review or cancel it before choosing another line.'); return }
              const line = e.newLine && e.newLine > 0 ? e.newLine : e.oldLine
              if (!line || line < 1) return
              setLineError(null)
              review.updateDraft({ pendingInline: { path: file.path, line, side: e.newLine && e.newLine > 0 ? 'RIGHT' : 'LEFT', body: '' } })
            }} style={{ flexGrow: 1, minHeight: 100, minWidth: 0 }} /> : <Label color={t.textSecondary} size={12}>No patch available for this file.</Label>}
            {file.patch_truncated && <Label color={t.textSecondary} size={11}>GitHub omitted or truncated this patch. Open the pull request on GitHub to read the full file.</Label>}
          </>}
        </div>
      </div>
    </>}
    {lineError && <Label color={t.warning} size={12}>{lineError}</Label>}
    {pending && <div style={{ ...column, gap: 8, padding: 10, borderRadius: 8, borderWidth: 1, borderColor: t.border }}><Label color={t.text} size={12}>{`Comment on line ${pending.line} · ${pending.side === 'LEFT' ? 'original' : 'new'} version · ${pending.path}`}</Label><textarea testId="pr-inline-body" autoFocus minRows={2} maxRows={4} value={pending.body} onChange={e => review.updateDraft({ pendingInline: { ...pending, body: (e.value ?? '').slice(0, 65536) } })} style={{ minHeight: 72, color: t.text, backgroundColor: t.buttonSecondary, fontSize: 13, padding: 8, borderRadius: 8 }} /><div style={{ ...row, justifyContent: 'flex-end' }}><Button onClick={() => { review.updateDraft({ pendingInline: null }); setLineError(null) }}>Cancel</Button><Button testId="pr-inline-save" primary disabled={!pending.body.trim() || stale || review.draft.inline.length >= 100} onClick={() => { review.updateDraft({ inline: [...review.draft.inline, pending], pendingInline: null }); setLineError(null) }}>Add to review</Button></div></div>}
  </div>
}

const SOURCES = [['comments', 'Comments'], ['reviews', 'Reviews'], ['review_comments', 'Inline comments']] as const
export function Timeline({ projectId, number, review, onSend }: { projectId: string; number: number; review: Review; onSend: () => void }) {
  const t = useTheme(); const [kind, setKind] = useState<PrPageKind>('comments'); const [page, setPage] = useState(1)
  const { data, error } = usePage(projectId, number, kind, page, review.revision, review.detail?.head_sha)
  return <div testId="pr-timeline" style={{ ...column, flexGrow: 1, minHeight: 0 }}><div style={{ ...row, paddingLeft: 24, paddingRight: 24, paddingTop: 12, paddingBottom: 0 }}><Segments value={kind} options={SOURCES} onChange={v => { setKind(v); setPage(1) }} testId="pr-source" width={[90,74,126]} plain /></div>
    {error ? <div style={{ padding: 24 }}><Problem error={error} refresh={review.refresh} /></div> : <virtual-list {...PR_SCROLL_LAYOUT} testId="pr-timeline-entries" estimatedItemHeight={140} style={{ flexGrow: 1, minHeight: 0 }}>
      {!data ? <div key="loading" style={{ padding: 24 }}><Label color={t.textSecondary}>Loading…</Label></div> : data.entries.length === 0 ? <div key="empty" style={{ padding: 24 }}><Label color={t.textSecondary}>{`No ${SOURCES.find(s => s[0] === kind)?.[1].toLowerCase() ?? 'comments'} on this page.`}</Label></div> : data.entries.map(entry => <Entry key={`${kind}:${entry.id}`} entry={entry} checked={review.draft.selected.includes(`${kind}:${entry.id}`)} onToggle={() => review.saveDraft(toggleReviewFinding(review.draft, `${kind}:${entry.id}`, entry))} />)}
      <div key="pagination" style={{ ...row, justifyContent: 'space-between', padding: 24 }}><Label color={t.textSecondary} size={13}>{`Page ${page}`}</Label><Pager page={page} more={!!data?.has_more} loading={!data} setPage={setPage} /></div>
    </virtual-list>}
    {review.draft.selected.length > 0 && <div style={{ ...row, justifyContent: 'center', paddingBottom: 12 }}><Label color={t.text} size={13}>{`${review.draft.selected.length} selected`}</Label><Button onClick={() => review.updateDraft({ selected: [], findings: {} })}>Clear</Button><Button onClick={onSend}>Send to agent</Button></div>}
  </div>
}

const Entry = memo(function Entry({ entry, checked, onToggle }: { entry: PrReviewEntry; checked: boolean; onToggle: () => void }) {
  const t = useTheme(); const [open, setOpen] = useState(true); const [clamped, setClamped] = useState(true)
  const body = entry.body || 'No review summary.'; const lines = body.split('\n'); const tall = lines.length > 16
  return <div style={{ paddingLeft: 24, paddingRight: 24 }}><div style={{ ...column, borderBottomWidth: 1, borderColor: t.border, paddingBottom: 12 }}><div style={{ ...row, paddingTop: 10, paddingBottom: 10 }}><div testId={`pr-select-${entry.id}`} role="checkbox" aria-checked={checked} tabIndex={0} onClick={onToggle} onKeyDown={e => { if (e.key === 'space' || e.key === 'enter') onToggle() }} style={{ ...row, width: 16, height: 16, borderRadius: 4, borderWidth: 1, borderColor: t.border, backgroundColor: checked ? t.buttonPrimary : t.buttonSecondary, justifyContent: 'center' }}>{checked && <Icon source={N.check} size={12} color={t.buttonPrimaryText} />}</div><div role="button" tabIndex={0} aria-expanded={open} onClick={() => setOpen(!open)} onKeyDown={e => { if (e.key === 'enter' || e.key === 'space') setOpen(!open) }} style={{ ...row, flexGrow: 1, cursor: 'pointer' }}><div style={{ ...row, width: 20, height: 20, justifyContent: 'center', borderWidth: 1, borderColor: t.border, borderRadius: 10 }}><Label color={t.textSecondary} size={10} lineHeight={14}>{entry.author.slice(0,1).toUpperCase()}</Label></div><Label color={t.text} size={14} lineHeight={21} weight={500}>{entry.author}</Label>{entry.state && <div style={{ borderRadius: 8, paddingLeft: 8, paddingRight: 8, backgroundColor: entry.state === 'APPROVED' ? alpha(t.green,.12) : ink(t,.07) }}><Label color={entry.state === 'APPROVED' ? t.green : entry.state === 'CHANGES_REQUESTED' ? t.red : t.textSecondary} size={13} lineHeight={18}>{entry.state.toLowerCase().replaceAll('_', ' ').replace(/^./, c => c.toUpperCase())}</Label></div>}<Label color={t.textSecondary} size={13} font={FONT_MONO} truncate style={{ flexGrow: 1 }}>{entry.path ? `${entry.path}:${entry.line ?? 'outdated'}` : ''}</Label><Label color={t.textSecondary} size={13}>{relativeTime(entry.updated_at)}</Label><Icon source={open ? N.chevronDown : N.chevronRight} size={14} color={t.textSecondary} /></div></div>{open && <div style={{ ...column, paddingLeft: 52, gap: 8 }}><markdown source={tall && clamped ? lines.slice(0, 16).join('\n') : body} theme={markdownTheme(t)} onLinkClick={e => e.value && openUrl(e.value)} style={{ color: t.text, fontSize: 15 }} />{tall && <Button onClick={() => setClamped(!clamped)}>{clamped ? 'Show more' : 'Show less'}</Button>}</div>}</div></div>
})
function Pager({ page, more, loading, setPage }: { page: number; more: boolean; loading: boolean; setPage: (n: number) => void }) { return <div style={row}><Button testId="pr-page-previous" disabled={loading || page <= 1} onClick={() => setPage(page - 1)}>Previous page</Button><Button testId="pr-page-next" disabled={loading || !more} onClick={() => setPage(page + 1)}>Next page</Button></div> }
