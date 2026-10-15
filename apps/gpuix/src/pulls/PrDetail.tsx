import { Icon, glyph } from '../icons.tsx'
import { N } from '../nav/glyphs.ts'
import { Copy01Icon, Link01Icon, LinkSquare02Icon, Robot01Icon } from '@hugeicons/core-free-icons'
import { alpha, cachedMarkdownTheme as markdownTheme } from '../transcript/kit.tsx'
import { useEffect, useState, type ReactNode } from 'react'
import { clearReviewDraft, reuseReviewDraftText, reviewDraftIsStale } from '@/state/prReviewModel'
import { agoPhrase } from '@/views/pullRequests/prFormat'
import { checkBucket, checksPhrase, sortChecks, summarizeChecks } from '@/views/pullRequests/prChecks'
import type { PrActionKind, PrDetailResult, Project } from '../../../../packages/kybern-client/src/types.ts'
import { useApp } from '../state.ts'
import { Menu, MenuItem, Dialog, DialogHeader, Tip } from '../nav/overlay.tsx'
import { popoverStyle, PopupLayer } from '../composer/Menu.tsx'
import { getNav } from '../nav/store.ts'
import { ink, Label, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { Button, column, row, Segments } from '../usage/controls.tsx'
import { Problem, copy, openUrl } from './PrStates.tsx'
import { SendPopover } from './PrSend.tsx'
import { Changes, Timeline } from './PrTabs.tsx'
import { useReview, type Review } from './useReview.ts'

type Tab = 'summary' | 'changes' | 'timeline'
export function Detail({ project, number, onBack, width, onChanged, showBack = true }: { project: Project; number: number; onBack: () => void; width: number; onChanged: () => void; showBack?: boolean }) {
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
      {showBack && <Button label="Back to pull requests" testId="pr-back" onClick={onBack}><Icon source={N.arrowLeft} size={16} color={t.textSecondary} /></Button>}
      <Segments value={tab} onChange={setTab} testId="pr-tab" plain width={[82, width >= 736 && pr?.additions != null ? 146 : 82, 100]} options={(['summary', 'changes', 'timeline'] as const).map(key => [key, <div style={{ ...row, gap: 6 }}><Label color={tab === key ? t.text : t.textSecondary} size={14}>{key === 'summary' ? 'Summary' : key === 'changes' ? 'Changes' : 'Timeline'}</Label>{key === 'changes' && width >= 736 && pr?.additions != null && pr.deletions != null && <div style={{ ...row, gap: 3 }}><Label color={t.green} size={13}>{`+${pr.additions}`}</Label><Label color={t.red} size={13}>{`−${pr.deletions}`}</Label></div>}{key === 'timeline' && detail?.comment_count != null && <Label color={t.textSecondary} size={13}>{detail.comment_count}</Label>}</div>] as const)} />
      <div style={{ flexGrow: 1 }} />
      {width >= 736 ? <div style={{ ...row, gap: 4 }}><Button label="Refresh pull request" testId="pr-refresh-detail" disabled={loading} onClick={review.refresh} style={{ width: 28, paddingLeft: 0, paddingRight: 0 }}><Icon source={N.refresh} size={16} color={t.textSecondary} /></Button><Button label="Copy link" testId="pr-copy-link" disabled={!pr} onClick={() => pr && copy(pr.url)} style={{ width: 28, paddingLeft: 0, paddingRight: 0 }}><Icon source={glyph(Link01Icon)} size={16} color={t.textSecondary} /></Button><Button label="Open on GitHub" testId="pr-open-github" disabled={!pr} onClick={() => pr && openUrl(pr.url)} style={{ width: 28, paddingLeft: 0, paddingRight: 0 }}><Icon source={glyph(LinkSquare02Icon)} size={16} color={t.textSecondary} /></Button></div> : <Menu testId="pr-more" align="end" trigger={() => <Button><Icon source={N.ellipsis} size={16} color={t.textSecondary} /></Button>}><MenuItem id="refresh" label="Refresh" disabled={loading} onSelect={review.refresh} /><MenuItem id="copy" label="Copy link" disabled={!pr} onSelect={() => pr && copy(pr.url)} /><MenuItem id="github" label="Open on GitHub" disabled={!pr} onSelect={() => pr && openUrl(pr.url)} /></Menu>}

      {detail && <>
        <div style={{ position: 'relative', display: 'flex' }}><Button label="Send to agent" testId="pr-send" onClick={() => { setSendOpen(!sendOpen); setReviewOpen(false) }} style={{ borderWidth: 1, borderColor: t.border }}><Icon source={glyph(Robot01Icon)} size={14} color={t.text} /><Label color={t.text} size={14}>{width >= 672 ? 'Send to agent' : ''}</Label></Button>{sendOpen && <SendPopover projectId={project.id} review={review} close={() => setSendOpen(false)} onTimeline={() => setTab('timeline')} onChanges={() => setTab('changes')} />}</div>
        <div style={{ position: 'relative', display: 'flex' }}><Button label="Review" testId="pr-review" onClick={() => { setReviewOpen(!reviewOpen); setSendOpen(false) }} style={{ borderWidth: 1, borderColor: t.border }}><Icon source={N.pencil} size={14} color={t.textSecondary} /><Label color={t.text} size={14}>{width < 672 ? '' : review.draft.inline.length ? `Review ${review.draft.inline.length}` : 'Review'}</Label><Icon source={N.chevronDown} size={12} color={t.textSecondary} /></Button>{reviewOpen && <ReviewPopover review={review} close={() => setReviewOpen(false)} onChanged={onChanged} />}</div>
        {pr?.state === 'OPEN' && <div style={{ ...row, gap: 0 }}><Tip label={mergeReason ?? 'Squash merge pull request'}><div><Button testId="pr-merge" primary disabled={review.busy || !!mergeReason} onClick={() => openConfirmation('merge')} style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0 }}>Merge</Button></div></Tip><Menu testId="pr-merge-menu" align="end" trigger={() => <Button primary style={{ width: 24, paddingLeft: 0, paddingRight: 0, borderTopLeftRadius: 0, borderBottomLeftRadius: 0 }}><Icon source={N.chevronDown} size={12} color={t.buttonPrimaryText} /></Button>}><MenuItem id="checkout" testId="pr-checkout" label="Check out in conversation" disabled={review.busy || !linked || linked.status === 'running' || linked.status === 'awaiting-approval'} onSelect={() => openConfirmation('checkout')} /><MenuItem id="close" testId="pr-close" label="Close pull request" disabled={review.busy} onSelect={() => openConfirmation('close')} /></Menu></div>}
      </>}
    </div>
    {error && <div style={{ padding: 24 }}><Problem error={error} refresh={review.refresh} /></div>}
    {!detail && !error && <div style={{ padding: 24 }}><Label color={t.textSecondary}>Loading pull request…</Label></div>}
    {detail && (tab === 'summary' ? <Summary detail={detail} project={project.name} width={width} onTimeline={() => setTab('timeline')} /> : tab === 'changes' ? <Changes projectId={project.id} number={number} review={review} compact={width < 700} /> : <Timeline projectId={project.id} number={number} review={review} onSend={() => { setSendOpen(true); setReviewOpen(false) }} />)}
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
  return <PopupLayer still={getNav().keyboardNav || REDUCED_MOTION} testId="pr-review-popover" side="bottom" align="end" sideOffset={6} tabIndex={0} onMouseDownOutside={close} onKeyDown={e => { if (e.key === 'escape') close() }} style={{ ...popoverStyle(t), ...column, width: 416, padding: 16, gap: 8 }}>
    <div style={column}><Label color={t.text} size={14} lineHeight={21} weight={500}>Review</Label><Label color={t.textSecondary} size={13} lineHeight={19.5}>Drafts stay here until GitHub accepts them.</Label></div>
    {stale && detail && <div style={{ ...column, gap: 8 }}><Label color={t.warning} size={14}>{`This draft refers to commit ${draft.sourceHead?.slice(0, 8) ?? 'unknown'}. The current commit is ${detail.head_sha.slice(0, 8)}. Review its changes before reusing your text. Inline comments need new line anchors.`}</Label><Button disabled={busy || !!draft.inline.length || !!draft.pendingInline} onClick={() => review.saveDraft(reuseReviewDraftText(draft, detail.head_sha))}>Use draft text for current commit</Button><Button disabled={busy} onClick={() => review.saveDraft(clearReviewDraft(draft))}>Clear review draft</Button></div>}
    {draft.inline.length > 0 && <div style={{ ...column, gap: 4 }}><Label color={t.textSecondary} size={13}>{`${draft.inline.length} inline ${draft.inline.length === 1 ? 'comment' : 'comments'}`}</Label><virtual-list estimatedItemHeight={48} style={{ height: Math.min(144, draft.inline.length * 48) }}>{draft.inline.map((c, i) => <div key={`${i}:${c.path}`} style={{ ...row, paddingTop: 4, paddingBottom: 4 }}><Label color={t.textSecondary} size={13} truncate style={{ flexGrow: 1 }}>{`${c.path}:${c.line} · ${c.body}`}</Label><Button onClick={() => review.updateDraft({ inline: draft.inline.filter((_, j) => i !== j) })}>Remove draft</Button></div>)}</virtual-list></div>}
    <Label color={t.textSecondary} size={13}>Summary</Label><textarea testId="pr-review-body" value={draft.body} onChange={e => review.updateDraft({ body: (e.value ?? '').slice(0, 65536) })} minRows={4} maxRows={6} style={{ minHeight: 112, color: t.text, fontSize: 14, backgroundColor: 'transparent', borderWidth: 1, borderColor: t.border, borderRadius: 8, padding: 8 }} />
    <div role="radiogroup" aria-label="Review type" style={{ ...column, gap: 2 }}>{([['comment', 'Comment', 'Post feedback without a verdict.'], ['approve', 'Approve', 'Approve these changes.'], ['request_changes', 'Request changes', 'Block merging until these are addressed.']] as const).map(([value, label, hint]) => {
      const disabled = value !== 'comment' && (!isOpen || stale || (value === 'request_changes' && empty))
      return <div key={value} testId={`pr-verdict-${value}`} role="radio" aria-checked={effective === value} tabIndex={disabled ? -1 : 0} onClick={() => { if (!disabled) setVerdict(value) }} onKeyDown={e => { if (!disabled && (e.key === 'enter' || e.key === 'space')) setVerdict(value) }} style={{ ...row, alignItems: 'flex-start', padding: 6, borderRadius: 8, opacity: disabled ? .5 : 1, hover: { backgroundColor: t.buttonSecondaryHover } }}><div style={{ ...row, justifyContent: 'center', width: 14, height: 14, marginTop: 2, borderRadius: 7, borderWidth: effective === value ? 4 : 1.5, borderColor: effective === value ? t.text : t.textSecondary, backgroundColor: 'transparent' }} /><div style={{ ...column, gap: 2 }}><Label color={t.text} size={14} lineHeight={21}>{label}</Label><Label color={t.textSecondary} size={13} lineHeight={19.5}>{hint}</Label></div></div>
    })}</div>
    {review.actionError && <Label color={t.red} size={14}>{`${review.actionError} Your draft is kept.`}</Label>}
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
  const heading = <div style={{ ...column, gap: 10 }}><div style={row}><div style={{ ...row, height: 24, borderRadius: 12, paddingLeft: 8, paddingRight: 8, backgroundColor: p.state === 'OPEN' && !p.is_draft ? alpha(t.green, .12) : ink(t, .07) }}><Icon source={N.pullRequest} size={14} color={p.state === 'OPEN' && !p.is_draft ? t.green : t.textSecondary} /><Label color={p.state === 'OPEN' && !p.is_draft ? t.green : p.state === 'MERGED' ? t.link : t.textSecondary} size={14}>{p.is_draft ? 'Draft' : p.state === 'OPEN' ? 'Open' : p.state === 'MERGED' ? 'Merged' : 'Closed'}</Label></div><Label color={t.textSecondary} size={14}>{`${project} #${p.number}`}</Label></div><Label color={t.text} size={24} weight={600} lineHeight={28}>{p.title}</Label><div style={{ ...row, gap: 6 }}><Avatar login={p.author} /><Label color={t.text} size={14} lineHeight={21} weight={500}>{p.author}</Label><Label color={t.textSecondary} size={14} lineHeight={21}>{`· opened ${agoPhrase(p.created_at ?? p.updated_at)} · ${p.head} → ${p.base}`}</Label></div>{!!p.labels?.length && <div style={{ ...row, flexWrap: 'wrap' }}>{p.labels.map(l => <div key={l.name} style={{ ...row, height: 20, borderRadius: 10, borderWidth: 1, borderColor: t.border, paddingLeft: 8, paddingRight: 8 }}><div style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: /^[\da-f]{6}$/i.test(l.color) ? `#${l.color}` : t.textSecondary }} /><Label color={t.textSecondary} size={13}>{l.name}</Label></div>)}</div>}</div>
  const info = <div style={{ ...column, gap: 24, width: width >= 832 ? 288 : '100%', flexShrink: 0 }}>
    <Info title="Merge status"><div style={row}><Icon source={p.is_draft ? N.pencil : p.mergeable === 'CONFLICTING' ? N.x : detail.merge_state_status === 'UNKNOWN' ? N.loader : N.circleCheck} size={16} color={p.is_draft || p.state !== 'OPEN' || detail.merge_state_status === 'UNKNOWN' ? t.textSecondary : p.mergeable === 'CONFLICTING' ? t.red : t.green} /><Label color={t.text} size={14} lineHeight={21}>{mergeStatus(detail)}</Label></div><div style={{ ...row, marginTop: 4 }}><Label color={t.textSecondary} size={13}>{`Head ${detail.head_sha.slice(0, 8)}`}</Label><Button label="Copy head commit" onClick={() => copy(detail.head_sha)} style={{ width: 20, height: 20, paddingLeft: 0, paddingRight: 0 }}><Icon source={glyph(Copy01Icon)} size={12} color={t.textSecondary} /></Button></div></Info>
    <Info title="Reviews">{p.review_decision && <Label color={p.review_decision === 'APPROVED' ? t.green : t.text} size={14} lineHeight={21}>{reviewLabels[p.review_decision] ?? p.review_decision}</Label>}{detail.reviews?.length ? detail.reviews.map(r => <div key={r.login} style={{ ...row, minHeight: 22, marginTop: 6 }}><Avatar login={r.login} /><Label color={t.text} size={14} lineHeight={21} style={{ flexGrow: 1 }}>{r.login}</Label><Icon source={r.state === 'APPROVED' ? N.circleCheck : N.clock} size={14} color={r.state === 'APPROVED' ? t.green : t.textSecondary} /></div>) : <Label color={t.textSecondary} size={14}>No reviews yet</Label>}</Info>
    <Info title="Checks"><div style={row}><Icon source={summary.pending ? N.loader : N.circleCheck} size={16} color={summary.pending ? t.warning : t.green} /><Label color={t.text} size={14} lineHeight={21}>{checksPhrase(summary)}</Label></div>{(expanded ? checks : checks.slice(0, 6)).map((check, i) => <div key={`${i}:${check.name}`} onClick={() => openUrl(check.url)} style={{ ...row, height: 28, marginTop: i === 0 ? 6 : 0, cursor: check.url ? 'pointer' : 'default' }}><Icon source={checkBucket(check) === 'pending' ? N.loader : N.circleCheck} size={14} color={checkBucket(check) === 'failed' ? t.red : checkBucket(check) === 'pending' ? t.warning : t.green} /><Label color={t.textSecondary} size={14} truncate>{check.name}</Label></div>)}{checks.length > 6 && <Button onClick={() => setExpanded(!expanded)}>{expanded ? 'Show less' : `Show all ${checks.length} checks`}</Button>}</Info>
    {detail.comment_count !== undefined && <Info title="Comments"><Button onClick={onTimeline} style={{ justifyContent: 'flex-start', height: 21, paddingLeft: 0, paddingRight: 0 }}>{detail.comment_count ? `${detail.comment_count} ${detail.comment_count === 1 ? 'comment' : 'comments'}` : 'No comments'}</Button></Info>}
  </div>
  return <virtual-list testId="pr-summary" style={{ flexGrow: 1, minHeight: 0 }} estimatedItemHeight={400}><div key="summary" style={{ ...column, padding: 24, paddingBottom: 64 }}>{width >= 832 ? <div style={{ display: 'flex', gap: 48 }}><div style={{ ...column, flexGrow: 1, gap: 24 }}>{heading}<markdown source={body || 'No description provided.'} theme={markdownTheme(t)} style={{ color: t.text, fontSize: 15 }} onLinkClick={e => e.value && openUrl(e.value)} /></div>{info}</div> : <div style={{ ...column, gap: 24 }}>{heading}{info}<markdown source={body || 'No description provided.'} theme={markdownTheme(t)} style={{ color: t.text, fontSize: 15 }} onLinkClick={e => e.value && openUrl(e.value)} /></div>}</div></virtual-list>
}
function Info({ title, children }: { title: string; children: ReactNode }) { const t = useTheme(); return <div style={{ ...column, gap: 0 }}><Label color={t.textSecondary} size={13} lineHeight={19.5} weight={500}>{title}</Label>{children}</div> }

function Avatar({ login }: { login: string }) { const t = useTheme(); return <div style={{ ...row, width: 16, height: 16, justifyContent: 'center', borderWidth: 1, borderColor: t.border, borderRadius: 8 }}><Label color={t.textSecondary} size={9} lineHeight={12}>{login.slice(0,1).toUpperCase()}</Label></div> }
