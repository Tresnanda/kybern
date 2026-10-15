import { useEffect, useState, type ReactNode } from 'react'
import { clearReviewDraft, reuseReviewDraftText, reviewDraftIsStale } from '@/state/prReviewModel'
import { agoPhrase } from '@/views/pullRequests/prFormat'
import { checkBucket, checksPhrase, sortChecks, summarizeChecks } from '@/views/pullRequests/prChecks'
import type { PrActionKind, PrDetailResult, Project } from '../../../../packages/kybern-client/src/types.ts'
import { useApp } from '../state.ts'
import { Menu, MenuItem, Dialog, DialogHeader, Tip } from '../nav/overlay.tsx'
import { popoverStyle, PopupLayer } from '../composer/Menu.tsx'
import { getNav } from '../nav/store.ts'
import { ink, Label, useTheme } from '../ui.tsx'
import { Button, column, row, Segments } from '../usage/controls.tsx'
import { Problem, copy, openUrl } from './PrStates.tsx'
import { SendPopover } from './PrSend.tsx'
import { Changes, Timeline } from './PrTabs.tsx'
import { useReview, type Review } from './useReview.ts'

type Tab = 'summary' | 'changes' | 'timeline'
export function Detail({ project, number, onBack, width, onChanged }: { project: Project; number: number; onBack: () => void; width: number; onChanged: () => void }) {
  const t = useTheme()
  const review = useReview(project.id, number)
  const { detail, loading, error } = review
  const [tab, setTab] = useState<Tab>('summary')
  const [sendOpen, setSendOpen] = useState(false)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [confirmation, setConfirmation] = useState<{ action: PrActionKind; head: string } | null>(null)
  const threads = useApp(s => s.threads)
  const linked = threads.find(th => th.project_id === project.id && th.worktree?.branch === detail?.pull_request.head && !th.subagent && !th.delegation)
  const pr = detail?.pull_request
  const mergeReason = pr?.is_draft ? 'Mark this pull request ready on GitHub before merging.' : pr?.mergeable === 'CONFLICTING' || detail?.merge_state_status === 'DIRTY' ? 'Resolve conflicts before merging.' : undefined
  // One bounded follow-up: GitHub computes mergeability lazily. No polling loop.
  const [mergeRetry, setMergeRetry] = useState(false)
  useEffect(() => {
    if (!detail || mergeRetry || detail.pull_request.state !== 'OPEN' || (detail.merge_state_status && detail.merge_state_status !== 'UNKNOWN')) return
    const timer = setTimeout(() => { setMergeRetry(true); review.refresh() }, 1800)
    return () => clearTimeout(timer)
  }, [detail, mergeRetry])
  const openConfirmation = (action: PrActionKind) => { if (detail) setConfirmation({ action, head: detail.head_sha }) }
  return <div testId="pr-detail" style={{ ...column, flexGrow: 1, minHeight: 0 }}>
    <div style={{ ...row, flexWrap: 'wrap', gap: 6, minHeight: 46, paddingLeft: 12, paddingRight: 12, paddingTop: 4, paddingBottom: 4, borderBottomWidth: 1, borderColor: t.border }}>
      <Button testId="pr-back" onClick={onBack}>‹</Button>
      <Segments value={tab} options={ [['summary', 'Summary'], ['changes', 'Changes'], ['timeline', 'Timeline']] } onChange={setTab} testId="pr-tab" width={70} plain />
      <div style={{ flexGrow: 1 }} />
      <Menu testId="pr-more" align="end" trigger={() => <Button>···</Button>}><MenuItem id="refresh" label="Refresh" disabled={loading} onSelect={review.refresh} /><MenuItem id="copy" label="Copy link" disabled={!pr} onSelect={() => pr && copy(pr.url)} /><MenuItem id="github" label="Open on GitHub" disabled={!pr} onSelect={() => pr && openUrl(pr.url)} /></Menu>
      {detail && <>
        <div style={{ position: 'relative', display: 'flex' }}><Button testId="pr-send" onClick={() => { setSendOpen(!sendOpen); setReviewOpen(false) }} style={{ borderWidth: 1, borderColor: t.border }}>Send to agent</Button>{sendOpen && <SendPopover projectId={project.id} review={review} close={() => setSendOpen(false)} onTimeline={() => setTab('timeline')} onChanges={() => setTab('changes')} />}</div>
        <div style={{ position: 'relative', display: 'flex' }}><Button testId="pr-review" onClick={() => { setReviewOpen(!reviewOpen); setSendOpen(false) }} style={{ borderWidth: 1, borderColor: t.border }}>{review.draft.inline.length ? `Review ${review.draft.inline.length}⌄` : 'Review⌄'}</Button>{reviewOpen && <ReviewPopover review={review} close={() => setReviewOpen(false)} onChanged={onChanged} />}</div>
        {pr?.state === 'OPEN' && <div style={{ ...row, gap: 0 }}><Tip label={mergeReason ?? 'Squash merge pull request'}><div><Button testId="pr-merge" primary disabled={review.busy || !!mergeReason} onClick={() => openConfirmation('merge')} style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0 }}>Merge</Button></div></Tip><Menu testId="pr-merge-menu" align="end" trigger={() => <Button primary style={{ width: 24, paddingLeft: 0, paddingRight: 0, borderTopLeftRadius: 0, borderBottomLeftRadius: 0 }}>⌄</Button>}><MenuItem id="checkout" label="Check out in conversation" disabled={review.busy || !linked || linked.status === 'running' || linked.status === 'awaiting-approval'} onSelect={() => openConfirmation('checkout')} /><MenuItem id="close" label="Close pull request" disabled={review.busy} onSelect={() => openConfirmation('close')} /></Menu></div>}
      </>}
    </div>
    {error && <div style={{ padding: 24 }}><Problem error={error} refresh={review.refresh} /></div>}
    {!detail && !error && <div style={{ padding: 24 }}><Label color={t.textSecondary}>Loading pull request…</Label></div>}
    {detail && (tab === 'summary' ? <Summary detail={detail} project={project.name} width={width} onTimeline={() => setTab('timeline')} /> : tab === 'changes' ? <Changes projectId={project.id} number={number} review={review} /> : <Timeline projectId={project.id} number={number} review={review} onSend={() => { setSendOpen(true); setReviewOpen(false) }} />)}
    {confirmation && detail && <Dialog instant={getNav().keyboardNav} testId="pr-confirm" onClose={() => { if (!review.busy) setConfirmation(null) }}><DialogHeader title={`${confirmation.action === 'merge' ? 'Merge pull request' : confirmation.action === 'close' ? 'Close pull request' : 'Check out pull request'}?`} description={confirmation.action === 'merge' ? `Squash merge #${number} at the reviewed head into ${pr?.base}. The branch stays available.` : confirmation.action === 'close' ? `Close #${number} on GitHub. Its branch and your drafts remain available.` : `Check out #${number} in ${linked?.title ?? 'the linked conversation'}. Running work, dirty files and open terminals block checkout.`} onClose={() => { if (!review.busy) setConfirmation(null) }} />{review.actionError && <div style={{ padding: 16 }}><Label color={t.red}>{`${review.actionError} Your draft is kept.`}</Label></div>}<div style={{ ...row, justifyContent: 'flex-end', padding: 16 }}><Button disabled={review.busy} onClick={() => setConfirmation(null)}>Cancel</Button><Button testId="pr-confirm-submit" primary disabled={review.busy} onClick={() => { void review.submit(confirmation.action, confirmation.head, linked?.id).then(ok => { if (ok) { setConfirmation(null); onChanged() } }) }}>{review.busy ? 'Working…' : confirmation.action === 'merge' ? 'Merge pull request' : confirmation.action === 'close' ? 'Close pull request' : 'Check out pull request'}</Button></div></Dialog>}
  </div>
}

function ReviewPopover({ review, close, onChanged }: { review: Review; close: () => void; onChanged: () => void }) {
  const t = useTheme(); const [verdict, setVerdict] = useState<'comment' | 'approve' | 'request_changes'>('comment')
  const { draft, detail, busy } = review
  const stale = detail ? reviewDraftIsStale(draft, detail.head_sha) : false
  const empty = !draft.body.trim() && !draft.inline.length
  const isOpen = detail?.pull_request.state === 'OPEN'
  const effective = verdict !== 'comment' && (!isOpen || stale || (verdict === 'request_changes' && empty)) ? 'comment' : verdict
  const submitLabel = effective === 'approve' ? 'Approve' : effective === 'request_changes' ? 'Request changes' : `Post comment${draft.inline.length ? ` and ${draft.inline.length} inline ${draft.inline.length === 1 ? 'draft' : 'drafts'}` : ''}`
  return <PopupLayer still={getNav().keyboardNav} testId="pr-review-popover" side="bottom" align="end" sideOffset={6} tabIndex={0} onMouseDownOutside={close} onKeyDown={e => { if (e.key === 'escape') close() }} style={{ ...popoverStyle(t), ...column, width: 416, padding: 16, gap: 12 }}>
    <Label color={t.text} size={13} weight={500}>Review</Label><Label color={t.textSecondary} size={11}>Drafts stay here until GitHub accepts them.</Label>
    {stale && detail && <div style={{ ...column, gap: 8 }}><Label color={t.warning} size={12}>{`This draft refers to commit ${draft.sourceHead?.slice(0, 8) ?? 'unknown'}. The current commit is ${detail.head_sha.slice(0, 8)}. Review its changes before reusing your text. Inline comments need new line anchors.`}</Label><Button disabled={busy || !!draft.inline.length || !!draft.pendingInline} onClick={() => review.saveDraft(reuseReviewDraftText(draft, detail.head_sha))}>Use draft text for current commit</Button><Button disabled={busy} onClick={() => review.saveDraft(clearReviewDraft(draft))}>Clear review draft</Button></div>}
    {draft.inline.length > 0 && <div style={{ ...column, gap: 4 }}><Label color={t.textSecondary} size={11}>{`${draft.inline.length} inline ${draft.inline.length === 1 ? 'comment' : 'comments'}`}</Label><virtual-list estimatedItemHeight={48} style={{ height: Math.min(144, draft.inline.length * 48) }}>{draft.inline.map((c, i) => <div key={`${i}:${c.path}`} style={{ ...row, paddingTop: 4, paddingBottom: 4 }}><Label color={t.textSecondary} size={11} truncate style={{ flexGrow: 1 }}>{`${c.path}:${c.line} · ${c.body}`}</Label><Button onClick={() => review.updateDraft({ inline: draft.inline.filter((_, j) => i !== j) })}>Remove draft</Button></div>)}</virtual-list></div>}
    <Label color={t.textSecondary} size={11}>Summary</Label><textarea testId="pr-review-body" value={draft.body} onChange={e => review.updateDraft({ body: (e.value ?? '').slice(0, 65536) })} minRows={4} maxRows={6} style={{ minHeight: 112, color: t.text, fontSize: 13, backgroundColor: t.buttonSecondary, borderRadius: 8, padding: 8 }} />
    {([['comment', 'Comment', 'Post feedback without a verdict.'], ['approve', 'Approve', 'Approve these changes.'], ['request_changes', 'Request changes', 'Block merging until these are addressed.']] as const).map(([value, label, hint]) => {
      const disabled = value !== 'comment' && (!isOpen || stale || (value === 'request_changes' && empty))
      return <div key={value} testId={`pr-verdict-${value}`} role="radio" aria-selected={effective === value} tabIndex={disabled ? -1 : 0} onClick={() => { if (!disabled) setVerdict(value) }} onKeyDown={e => { if (!disabled && (e.key === 'enter' || e.key === 'space')) setVerdict(value) }} style={{ ...row, alignItems: 'flex-start', padding: 8, borderRadius: 8, opacity: disabled ? .5 : 1, hover: { backgroundColor: t.buttonSecondaryHover } }}><Label color={t.text} size={13}>{effective === value ? '●' : '○'}</Label><div style={{ ...column, gap: 2 }}><Label color={t.text} size={13}>{label}</Label><Label color={t.textSecondary} size={11}>{hint}</Label></div></div>
    })}
    {review.actionError && <Label color={t.red} size={12}>{`${review.actionError} Your draft is kept.`}</Label>}
    <div style={{ ...row, justifyContent: 'flex-end' }}><Button onClick={close}>Cancel</Button><Button testId="pr-review-submit" primary disabled={busy || stale || (effective !== 'approve' && empty)} onClick={() => { void review.submit(effective).then(ok => { if (ok) { close(); onChanged() } }) }}>{busy ? 'Submitting…' : submitLabel}</Button></div>
  </PopupLayer>
}

function mergeStatus(detail: PrDetailResult) {
  const p = detail.pull_request; const s = detail.merge_state_status
  if (p.state === 'MERGED') return `Merged${detail.merged_by ? ` by ${detail.merged_by}` : ''} into ${p.base} ${agoPhrase(detail.merged_at ?? p.updated_at)}`
  if (p.state === 'CLOSED') return `Closed ${agoPhrase(detail.closed_at ?? p.updated_at)}`
  if (p.is_draft || s === 'DRAFT') return 'Draft. Mark it ready on GitHub to merge.'
  if (p.mergeable === 'CONFLICTING' || s === 'DIRTY') return `Conflicts with ${p.base}`
  if (s === 'BEHIND') return `Behind ${p.base}. Update the branch on GitHub.`
  if (s === 'BLOCKED') return 'Blocked by required reviews or checks'
  if (s === 'UNSTABLE') return 'Checks failing'
  if (s === 'CLEAN' || s === 'HAS_HOOKS') return 'Ready to merge'
  return 'Checking mergeability'
}
const reviewLabels: Record<string, string> = { APPROVED: 'Approved', CHANGES_REQUESTED: 'Changes requested', REVIEW_REQUIRED: 'Review required', COMMENTED: 'Commented', DISMISSED: 'Dismissed', REQUESTED: 'Requested' }
function Summary({ detail, project, width, onTimeline }: { detail: PrDetailResult; project: string; width: number; onTimeline: () => void }) {
  const t = useTheme(); const p = detail.pull_request; const [expanded, setExpanded] = useState(false)
  const checks = sortChecks(detail.checks); const summary = summarizeChecks(checks)
  const body = detail.body.replace(/<!--[\s\S]*?-->/g, '').trim()
  const heading = <div style={{ ...column, gap: 10 }}><div style={row}><div style={{ ...row, height: 24, borderRadius: 12, paddingLeft: 8, paddingRight: 8, backgroundColor: ink(t, .07) }}><Label color={p.state === 'OPEN' && !p.is_draft ? t.green : p.state === 'MERGED' ? t.link : t.textSecondary} size={12}>{p.is_draft ? 'Draft' : p.state === 'OPEN' ? 'Open' : p.state === 'MERGED' ? 'Merged' : 'Closed'}</Label></div><Label color={t.textSecondary} size={12}>{`${project} #${p.number}`}</Label></div><Label color={t.text} size={22} weight={600} lineHeight={28}>{p.title}</Label><Label color={t.textSecondary} size={12} lineHeight={18}>{`${p.author} · opened ${agoPhrase(p.created_at ?? p.updated_at)} · ${p.head} → ${p.base}`}</Label>{!!p.labels?.length && <div style={{ ...row, flexWrap: 'wrap' }}>{p.labels.map(l => <div key={l.name} style={{ ...row, height: 20, borderRadius: 10, borderWidth: 1, borderColor: t.border, paddingLeft: 8, paddingRight: 8 }}><div style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: /^[\da-f]{6}$/i.test(l.color) ? `#${l.color}` : t.textSecondary }} /><Label color={t.textSecondary} size={11}>{l.name}</Label></div>)}</div>}</div>
  const info = <div style={{ ...column, gap: 18, width: width >= 832 ? 288 : '100%', flexShrink: 0 }}>
    <Info title="Merge status"><Label color={t.text} size={13}>{mergeStatus(detail)}</Label><div style={row}><Label color={t.textSecondary} size={11}>{`Head ${detail.head_sha.slice(0, 8)}`}</Label><Button onClick={() => copy(detail.head_sha)}>Copy</Button></div></Info>
    <Info title="Reviews">{p.review_decision && <Label color={t.text} size={13}>{reviewLabels[p.review_decision] ?? p.review_decision}</Label>}{detail.reviews?.length ? detail.reviews.map(r => <Label key={r.login} color={t.textSecondary} size={12}>{`${r.login} · ${reviewLabels[r.state] ?? r.state}`}</Label>) : <Label color={t.textSecondary} size={12}>No reviews yet</Label>}</Info>
    <Info title="Checks"><Label color={t.text} size={13}>{checksPhrase(summary)}</Label>{(expanded ? checks : checks.slice(0, 6)).map((check, i) => <div key={`${i}:${check.name}`} onClick={() => openUrl(check.url)} style={{ ...row, height: 28, cursor: check.url ? 'pointer' : 'default' }}><div style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: checkBucket(check) === 'failed' ? t.red : checkBucket(check) === 'pending' ? t.warning : checkBucket(check) === 'passed' ? t.green : t.textSecondary }} /><Label color={t.textSecondary} size={12} truncate>{check.name}</Label></div>)}{checks.length > 6 && <Button onClick={() => setExpanded(!expanded)}>{expanded ? 'Show less' : `Show all ${checks.length} checks`}</Button>}</Info>
    {detail.comment_count !== undefined && <Info title="Comments"><Button onClick={onTimeline}>{detail.comment_count ? `${detail.comment_count} ${detail.comment_count === 1 ? 'comment' : 'comments'}` : 'No comments'}</Button></Info>}
  </div>
  return <virtual-list testId="pr-summary" style={{ flexGrow: 1, minHeight: 0 }} estimatedItemHeight={400}><div key="summary" style={{ ...column, padding: 24, paddingBottom: 64 }}>{width >= 832 ? <div style={{ display: 'flex', gap: 48 }}><div style={{ ...column, flexGrow: 1, gap: 24 }}>{heading}<markdown source={body || 'No description provided.'} theme={{ appearance: t.variant }} style={{ color: t.text, fontSize: 13 }} onLinkClick={e => e.value && openUrl(e.value)} /></div>{info}</div> : <div style={{ ...column, gap: 24 }}>{heading}{info}<markdown source={body || 'No description provided.'} theme={{ appearance: t.variant }} style={{ color: t.text, fontSize: 13 }} onLinkClick={e => e.value && openUrl(e.value)} /></div>}</div></virtual-list>
}
function Info({ title, children }: { title: string; children: ReactNode }) { const t = useTheme(); return <div style={{ ...column, gap: 6 }}><Label color={t.textSecondary} size={11} weight={500}>{title}</Label>{children}</div> }
