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
  return <div testId="pr-changes" style={{ ...column, flexGrow: 1, minHeight: 0, padding: 16, gap: 12 }}>
    {error ? <Problem error={error} refresh={review.refresh} /> : <>
      <div style={{ ...row, justifyContent: 'space-between' }}><Label color={t.textSecondary} size={11}>{files.length ? `${review.detail?.changed_files ?? files.length} files · ${(page - 1) * 30 + 1}–${(page - 1) * 30 + files.length}` : `${review.detail?.changed_files ?? 0} files`}</Label><Pager page={page} more={!!data?.has_more} loading={!data} setPage={p => { setPage(p); setPath(null) }} /></div>
      <div style={{ display: 'flex', flexDirection: compact ? 'column' : 'row', flexGrow: 1, minHeight: 0, gap: 16 }}>
        <virtual-list testId="pr-files" estimatedItemHeight={48} style={{ width: compact ? '100%' : 208, ...(compact ? { height: 112 } : {}), flexShrink: 0, minHeight: 0 }}>{files.map((f, i) => <div key={f.path} style={{ paddingBottom: 2 }}><div testId={`pr-file-${i}`} role="button" aria-label={f.path} tabIndex={0} onClick={() => setPath(f.path)} onKeyDown={e => { if (e.key === 'enter' || e.key === 'space') setPath(f.path) }} style={{ ...column, gap: 4, padding: 8, borderRadius: 6, backgroundColor: file?.path === f.path ? ink(t, .07) : 'transparent', hover: { backgroundColor: t.hover } }}><Label color={t.text} size={12} truncate>{f.path.split('/').pop()}</Label><Label color={t.textSecondary} size={11} truncate>{f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/') + 1) : f.status}</Label><div style={row}><Label color={t.green} size={11}>{`+${f.additions}`}</Label><Label color={t.red} size={11}>{`−${f.deletions}`}</Label>{review.draft.inline.some(c => c.path === f.path) && <Label color={t.link} size={11}>Draft</Label>}</div></div></div>)}</virtual-list>
        <div style={{ ...column, flexGrow: 1, minHeight: 0 }}>
          {!file ? <Label color={t.textSecondary} size={13}>{data ? 'No changed files on this page.' : 'Loading changes…'}</Label> : <>
            <div style={{ ...row, justifyContent: 'space-between', minHeight: 32 }}><Label color={t.text} size={12} truncate>{file.path}</Label><Button onClick={() => { if (review.detail) void prFileUrl(review.detail.pull_request.url, file.path).then(openUrl) }}>Open on GitHub</Button></div>
            {file.patch ? <diff key={file.path} testId="pr-native-diff" patch={patch} wordDiff scroll theme={{ appearance: t.variant }} onLineClick={e => {
              if (stale) { setLineError('This draft belongs to a different commit. Resolve the previous draft before choosing a new inline anchor.'); return }
              if (pending?.body.trim()) { setLineError('Add this comment to the review or cancel it before choosing another line.'); return }
              const line = e.newLine && e.newLine > 0 ? e.newLine : e.oldLine
              if (!line || line < 1) return
              setLineError(null)
              review.updateDraft({ pendingInline: { path: file.path, line, side: e.newLine && e.newLine > 0 ? 'RIGHT' : 'LEFT', body: '' } })
            }} style={{ flexGrow: 1, minHeight: 100, color: t.text, fontSize: 12, borderWidth: 1, borderColor: t.border, borderRadius: 8 }} /> : <Label color={t.textSecondary} size={12}>No patch available for this file.</Label>}
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
  return <div testId="pr-timeline" style={{ ...column, flexGrow: 1, minHeight: 0 }}><div style={{ ...row, paddingLeft: 24, paddingRight: 24, paddingTop: 12, paddingBottom: 12 }}><Segments value={kind} options={SOURCES} onChange={v => { setKind(v); setPage(1) }} testId="pr-source" width={108} plain /></div>
    {error ? <div style={{ padding: 24 }}><Problem error={error} refresh={review.refresh} /></div> : <virtual-list testId="pr-timeline-entries" estimatedItemHeight={140} style={{ flexGrow: 1, minHeight: 0 }}>
      {!data ? <div key="loading" style={{ padding: 24 }}><Label color={t.textSecondary}>Loading…</Label></div> : data.entries.length === 0 ? <div key="empty" style={{ padding: 24 }}><Label color={t.textSecondary}>{`No ${SOURCES.find(s => s[0] === kind)?.[1].toLowerCase() ?? 'comments'} on this page.`}</Label></div> : data.entries.map(entry => <Entry key={`${kind}:${entry.id}`} entry={entry} checked={review.draft.selected.includes(`${kind}:${entry.id}`)} onToggle={() => review.saveDraft(toggleReviewFinding(review.draft, `${kind}:${entry.id}`, entry))} />)}
    </virtual-list>}
    <div style={{ ...row, justifyContent: 'space-between', padding: 16 }}><Label color={t.textSecondary} size={11}>{`Page ${page}`}</Label><Pager page={page} more={!!data?.has_more} loading={!data} setPage={setPage} /></div>
    {review.draft.selected.length > 0 && <div style={{ ...row, justifyContent: 'center', paddingBottom: 12 }}><Label color={t.text} size={13}>{`${review.draft.selected.length} selected`}</Label><Button onClick={() => review.updateDraft({ selected: [], findings: {} })}>Clear</Button><Button onClick={onSend}>Send to agent</Button></div>}
  </div>
}

const Entry = memo(function Entry({ entry, checked, onToggle }: { entry: PrReviewEntry; checked: boolean; onToggle: () => void }) {
  const t = useTheme(); const [open, setOpen] = useState(true); const [clamped, setClamped] = useState(true)
  const body = entry.body || 'No review summary.'; const lines = body.split('\n'); const tall = lines.length > 16
  return <div style={{ paddingLeft: 24, paddingRight: 24 }}><div style={{ ...column, borderBottomWidth: 1, borderColor: t.border, paddingBottom: 12 }}><div style={{ ...row, paddingTop: 10, paddingBottom: 10 }}><Button onClick={onToggle}>{checked ? '☑' : '☐'}</Button><Button onClick={() => setOpen(!open)}>{`${open ? '⌄' : '›'} ${entry.author}`}</Button>{entry.state && <Label color={entry.state === 'APPROVED' ? t.green : entry.state === 'CHANGES_REQUESTED' ? t.red : t.textSecondary} size={11}>{entry.state.toLowerCase().replaceAll('_', ' ')}</Label>}<Label color={t.textSecondary} size={11} truncate style={{ flexGrow: 1 }}>{entry.path ? `${entry.path}:${entry.line ?? 'outdated'}` : ''}</Label><Label color={t.textSecondary} size={11}>{relativeTime(entry.updated_at)}</Label></div>{open && <div style={{ ...column, paddingLeft: 52, gap: 8 }}><markdown source={tall && clamped ? lines.slice(0, 16).join('\n') : body} theme={{ appearance: t.variant }} onLinkClick={e => e.value && openUrl(e.value)} style={{ color: t.text, fontSize: 13 }} />{tall && <Button onClick={() => setClamped(!clamped)}>{clamped ? 'Show more' : 'Show less'}</Button>}</div>}</div></div>
})
function Pager({ page, more, loading, setPage }: { page: number; more: boolean; loading: boolean; setPage: (n: number) => void }) { return <div style={row}><Button testId="pr-page-previous" disabled={loading || page <= 1} onClick={() => setPage(page - 1)}>Previous page</Button><Button testId="pr-page-next" disabled={loading || !more} onClick={() => setPage(page + 1)}>Next page</Button></div> }
