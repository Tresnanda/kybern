import { DocumentMarkdown } from '../native/markdownDocument.tsx'
import { PR_SCROLL_LAYOUT } from './scroll-layout.ts'
import { Icon, glyph } from '../icons.tsx'
import { SpinIcon } from '../kit/Spin.tsx'
import { N } from '../nav/glyphs.ts'
import { Copy01Icon, Link01Icon, LinkSquare02Icon, Robot01Icon } from '@hugeicons/core-free-icons'
import { alpha, cachedMarkdownTheme as markdownTheme } from '../transcript/kit.tsx'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { clearReviewDraft, reuseReviewDraftText, reviewDraftIsStale } from '@/state/prReviewModel'
import { agoPhrase } from '@/views/pullRequests/prFormat'
import { checkBucket, checksPhrase, sortChecks, summarizeChecks } from '@/views/pullRequests/prChecks'
import type { PrActionKind, PrDetailResult, Project } from '../../../../packages/kybern-client/src/types.ts'
import { useApp } from '../state.ts'
import { Menu, MenuItem, Dialog, DialogHeader, Tip } from '../nav/overlay.tsx'
import { popoverStyle, PopupLayer } from '../composer/Menu.tsx'
import { getNav } from '../nav/store.ts'
import { ink, Label, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { column, row } from '../usage/controls.tsx'
import { Button } from '../kit/Button.tsx'
import { IconButton } from '../kit/IconButton.tsx'
import { RadioRow } from '../kit/RadioRow.tsx'
import { SplitButton } from '../kit/SplitButton.tsx'
import { Tabs, type TabsItem } from '../kit/Tabs.tsx'
import { TextArea } from '../kit/TextArea.tsx'
import { PrLoading, Problem, copy, openUrl } from './PrStates.tsx'
import { Rise, SwapOnChange } from '../motion/kit.tsx'
import { SuccessCheck } from '../motion/SuccessCheck.tsx'
import { popTransform, useCountPop } from '../kit/Pop.tsx'
import { SendPopover } from './PrSend.tsx'
import { Changes, Timeline } from './PrTabs.tsx'
import { useReview, type Review } from './useReview.ts'

type Tab = 'summary' | 'changes' | 'timeline'
export function Detail({ project, number, repo, onBack, width, onChanged, showBack = true }: { project: Project; number: number; /** Group projects: the member repository the pull request is in. */ repo?: string; onBack: () => void; width: number; onChanged: () => void; showBack?: boolean }) {
  const t = useTheme()
  const review = useReview(project.id, number, repo)
  const memberName = repo ? project.members?.find(m => m.path === repo)?.name ?? repo : undefined
  const { detail, loading, error } = review
  const [tab, setTab] = useState<Tab>('summary')
  // A tab chosen by pointer rises in (`t-pane`); the keyboard shows it at once.
  const [paneIn, setPaneIn] = useState(false)
  const go = (next: Tab, byKey = false) => { setTab(next); setPaneIn(!byKey && !getNav().keyboardNav) }
  const [copied, flashCopied] = useFlash()
  const [merged, flashMerged] = useFlash()
  const [sendOpen, setSendOpen] = useState(false)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [confirmation, setConfirmation] = useState<{ action: PrActionKind; head: string } | null>(null)
  const threads = useApp(s => s.threads)
  // Checking a member's pull request out into a conversation isn't supported yet.
  const linked = repo ? undefined : threads.find(th => th.project_id === project.id && th.worktree?.branch === detail?.pull_request.head && !th.subagent && !th.delegation)
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
      {showBack && <IconButton icon={N.arrowLeft} label="Back to pull requests" testId="pr-back" onClick={onBack} />}
      {/* Summary, Changes and Timeline are tabs (ADE-55 §2.7), not a segmented control. */}
      <div style={{ ...row, height: 38, flexShrink: 1, minWidth: 0 }}>
        <Tabs testId="pr-tab" minWidth={0} overflow={false} animate={false} underlineGap={9} active={tab} onSelect={(key) => go(key as Tab)}
          items={(['summary', 'changes', 'timeline'] as const).map((key): TabsItem => ({
            key, label: key === 'summary' ? 'Summary' : key === 'changes' ? 'Changes' : 'Timeline', testId: `pr-tab-${key}`,
            ...(key === 'changes' && width >= 736 && pr?.additions != null && pr.deletions != null ? { extra: <div style={{ ...row, gap: 3 }}><Label color={t.green} size={12}>{`+${pr.additions}`}</Label><Label color={t.red} size={12}>{`−${pr.deletions}`}</Label></div> } : {}),
            ...(key === 'timeline' && detail?.comment_count != null ? { detail: String(detail.comment_count) } : {}),
          }))} />
      </div>
      <div style={{ flexGrow: 1 }} />
      {width >= 736 ? <div style={{ ...row, gap: 4 }}><IconButton icon={N.refresh} label="Refresh pull request" testId="pr-refresh-detail" disabled={loading} onClick={review.refresh}><SwapOnChange kind="icon" active={loading ? 'busy' : 'idle'} style={{ width: 16, height: 16 }}>{loading ? <SpinIcon testId="pr-detail-spinner" source={N.refresh} size={16} color={t.iconSecondary} /> : <Icon source={N.refresh} size={16} color={t.iconSecondary} />}</SwapOnChange></IconButton><IconButton icon={glyph(Link01Icon)} label="Copy link" testId="pr-copy-link" disabled={!pr} onClick={() => { if (pr) { copy(pr.url); flashCopied() } }}><SwapOnChange kind="icon" active={copied ? 'done' : 'link'} style={{ width: 16, height: 16 }}>{copied ? <Icon source={N.check} size={16} color={t.green} /> : <Icon source={glyph(Link01Icon)} size={16} color={t.iconSecondary} />}</SwapOnChange></IconButton><IconButton icon={glyph(LinkSquare02Icon)} label="Open on GitHub" testId="pr-open-github" disabled={!pr} onClick={() => pr && openUrl(pr.url)} /></div> : <Menu testId="pr-more" align="end" trigger={() => <IconButton icon={N.ellipsis} label="More actions" />}><MenuItem id="refresh" label="Refresh" disabled={loading} onSelect={review.refresh} /><MenuItem id="copy" label="Copy link" disabled={!pr} onSelect={() => pr && copy(pr.url)} /><MenuItem id="github" label="Open on GitHub" disabled={!pr} onSelect={() => pr && openUrl(pr.url)} /></Menu>}

      {detail && <>
        {!repo && <div style={{ position: 'relative', display: 'flex' }}><Button label="Send to agent" testId="pr-send" icon={glyph(Robot01Icon)} onClick={() => { setSendOpen(!sendOpen); setReviewOpen(false) }}>{width >= 672 ? 'Send to agent' : undefined}</Button>{sendOpen && <SendPopover projectId={project.id} review={review} close={() => setSendOpen(false)} onTimeline={() => go('timeline')} onChanges={() => go('changes')} />}</div>}
        <div style={{ position: 'relative', display: 'flex' }}><Button label="Review" testId="pr-review" icon={N.pencil} chevron={width >= 672} onClick={() => { setReviewOpen(!reviewOpen); setSendOpen(false) }}>{width < 672 ? undefined : review.draft.inline.length ? `Review ${review.draft.inline.length}` : 'Review'}</Button>{reviewOpen && <ReviewPopover review={review} close={() => setReviewOpen(false)} onChanged={onChanged} />}</div>
        {merged && <div testId="pr-merged" style={{ ...row, gap: 6, height: 28, paddingLeft: 10, paddingRight: 10 }}><SuccessCheck size={16} color={t.green} /><Label color={t.green} size={14}>Merged</Label></div>}
        {pr?.state === 'OPEN' && !merged && <Tip label={mergeReason ?? 'Squash merge pull request'}><div><SplitButton testId="pr-merge" menuTestId="pr-merge-menu" menuLabel="Merge options" keepMenu disabled={review.busy || !!mergeReason} onClick={() => openConfirmation('merge')} menu={<><MenuItem id="checkout" testId="pr-checkout" label="Check out in conversation" disabled={review.busy || !linked || linked.status === 'running' || linked.status === 'awaiting-approval'} onSelect={() => openConfirmation('checkout')} /><MenuItem id="close" testId="pr-close" label="Close pull request" disabled={review.busy} onSelect={() => openConfirmation('close')} /></>}>Merge</SplitButton></div></Tip>}
      </>}
    </div>
    {error && <div style={{ padding: 24 }}><Problem error={error} refresh={review.refresh} /></div>}
    {!detail && !error && <div style={{ padding: 24 }}><PrLoading label="Loading pull request…" /></div>}
    {detail && <Rise key={tab} kind="pane" play={paneIn} style={{ flexGrow: 1, minHeight: 0 }}>{tab === 'summary' ? <Summary detail={detail} project={memberName ? `${project.name} · ${memberName}` : project.name} width={width} onTimeline={() => go('timeline')} /> : tab === 'changes' ? <Changes projectId={project.id} number={number} repo={repo} review={review} compact={width < 700} /> : <Timeline projectId={project.id} number={number} repo={repo} review={review} onSend={() => { setSendOpen(true); setReviewOpen(false) }} />}</Rise>}
    {confirmation && detail && <Dialog instant={getNav().keyboardNav} testId="pr-confirm" onClose={() => { if (!review.busy) setConfirmation(null) }}><DialogHeader title={`${confirmation.action === 'merge' ? 'Merge pull request' : confirmation.action === 'close' ? 'Close pull request' : 'Check out pull request'}?`} description={confirmation.action === 'merge' ? `Squash merge #${number} at the reviewed head into ${pr?.base}. The branch stays available.` : confirmation.action === 'close' ? `Close #${number} on GitHub. Its branch and your drafts remain available.` : `Check out #${number} in ${linked?.title ?? 'the linked conversation'}. Running work, dirty files and open terminals block checkout.`} onClose={() => { if (!review.busy) setConfirmation(null) }} />{review.actionError && <div style={{ padding: 16 }}><Label color={t.red}>{`${review.actionError} Your draft is kept.`}</Label></div>}<div style={{ ...row, justifyContent: 'flex-end', gap: 8, padding: 16 }}><Button size="lg" disabled={review.busy} onClick={() => setConfirmation(null)}>Cancel</Button><Button size="lg" variant="primary" testId="pr-confirm-submit" disabled={review.busy} onClick={() => { void review.submit(confirmation.action, confirmation.head, linked?.id).then(ok => { if (ok) { if (confirmation.action === 'merge') flashMerged(); setConfirmation(null); onChanged() } }) }}>{review.busy ? 'Working…' : confirmation.action === 'merge' ? 'Merge pull request' : confirmation.action === 'close' ? 'Close pull request' : 'Check out pull request'}</Button></div></Dialog>}
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
    {stale && detail && <div style={{ ...column, gap: 8 }}><Label color={t.warning} size={14}>{`This draft refers to commit ${draft.sourceHead?.slice(0, 8) ?? 'unknown'}. The current commit is ${detail.head_sha.slice(0, 8)}. Review its changes before reusing your text. Inline comments need new line anchors.`}</Label><Button size="sm" disabled={busy || !!draft.inline.length || !!draft.pendingInline} onClick={() => review.saveDraft(reuseReviewDraftText(draft, detail.head_sha))}>Use draft text for current commit</Button><Button size="sm" disabled={busy} onClick={() => review.saveDraft(clearReviewDraft(draft))}>Clear review draft</Button></div>}
    {draft.inline.length > 0 && <div style={{ ...column, gap: 4 }}><Label color={t.textSecondary} size={13}>{`${draft.inline.length} inline ${draft.inline.length === 1 ? 'comment' : 'comments'}`}</Label><virtual-list estimatedItemHeight={48} style={{ height: Math.min(144, draft.inline.length * 48) }}>{draft.inline.map((c, i) => <div key={`${i}:${c.path}`} style={{ ...row, paddingTop: 4, paddingBottom: 4 }}><Label color={t.textSecondary} size={13} truncate style={{ flexGrow: 1 }}>{`${c.path}:${c.line} · ${c.body}`}</Label><Button variant="ghost" size="sm" onClick={() => review.updateDraft({ inline: draft.inline.filter((_, j) => i !== j) })}>Remove draft</Button></div>)}</virtual-list></div>}
    <Label color={t.textSecondary} size={13}>Summary</Label><TextArea label="Review summary" testId="pr-review-body" value={draft.body} onChange={v => review.updateDraft({ body: v.slice(0, 65536) })} minRows={4} maxRows={6} />
    <div role="radiogroup" aria-label="Review type" style={{ ...column, gap: 2 }}>{([['comment', 'Comment', 'Post feedback without a verdict.'], ['approve', 'Approve', 'Approve these changes.'], ['request_changes', 'Request changes', 'Block merging until these are addressed.']] as const).map(([value, label, hint]) => {
      const disabled = value !== 'comment' && (!isOpen || stale || (value === 'request_changes' && empty))
      return <RadioRow key={value} testId={`pr-verdict-${value}`} checked={effective === value} title={label} description={hint} disabled={disabled} onSelect={() => setVerdict(value)} />
    })}</div>
    {review.actionError && <Label color={t.red} size={14}>{`${review.actionError} Your draft is kept.`}</Label>}
    <div style={{ ...row, justifyContent: 'flex-end', gap: 8 }}><Button variant="ghost" onClick={close}>Cancel</Button><Button testId="pr-review-submit" variant="primary" disabled={busy || stale || (effective !== 'approve' && empty)} onClick={() => { void review.submit(effective).then(ok => { if (ok) { close(); onChanged() } }) }}>{busy ? 'Submitting…' : submitLabel}</Button></div>
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
  const t = useTheme(); const p = detail.pull_request; const [expanded, setExpanded] = useState(false); const [headCopied, flashHead] = useFlash()
  const checks = sortChecks(detail.checks); const summary = summarizeChecks(checks)
  const body = detail.body.replace(/<!--[\s\S]*?-->/g, '').trim()
  const heading = <div style={{ ...column, gap: 10 }}><div style={row}><StatePill pr={p} /><Label color={t.textSecondary} size={14}>{`${project} #${p.number}`}</Label></div><Label color={t.text} size={24} weight={600} lineHeight={28}>{p.title}</Label><div style={{ ...row, gap: 6 }}><Avatar login={p.author} /><Label color={t.text} size={14} lineHeight={21} weight={500}>{p.author}</Label><Label color={t.textSecondary} size={14} lineHeight={21}>{`· opened ${agoPhrase(p.created_at ?? p.updated_at)} · ${p.head} → ${p.base}`}</Label></div>{!!p.labels?.length && <div style={{ ...row, flexWrap: 'wrap' }}>{p.labels.map(l => <div key={l.name} style={{ ...row, height: 20, borderRadius: 10, borderWidth: 1, borderColor: t.border, paddingLeft: 8, paddingRight: 8 }}><div style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: /^[\da-f]{6}$/i.test(l.color) ? `#${l.color}` : t.textSecondary }} /><Label color={t.textSecondary} size={13}>{l.name}</Label></div>)}</div>}</div>
  const info = <div style={{ ...column, gap: 24, width: width >= 832 ? 288 : '100%', flexShrink: 0 }}>
    <Info title="Merge status"><div style={row}><Icon source={p.is_draft ? N.pencil : p.mergeable === 'CONFLICTING' ? N.x : detail.merge_state_status === 'UNKNOWN' ? N.loader : N.circleCheck} size={16} color={p.is_draft || p.state !== 'OPEN' || detail.merge_state_status === 'UNKNOWN' ? t.textSecondary : p.mergeable === 'CONFLICTING' ? t.red : t.green} /><Label color={t.text} size={14} lineHeight={21}>{mergeStatus(detail)}</Label></div><div style={{ ...row, marginTop: 4 }}><Label color={t.textSecondary} size={13}>{`Head ${detail.head_sha.slice(0, 8)}`}</Label><IconButton icon={glyph(Copy01Icon)} size="sm" glyph={12} label="Copy head commit" onClick={() => { copy(detail.head_sha); flashHead() }}><SwapOnChange kind="icon" active={headCopied ? 'done' : 'copy'} style={{ width: 12, height: 12 }}>{headCopied ? <Icon source={N.check} size={12} color={t.green} /> : <Icon source={glyph(Copy01Icon)} size={12} color={t.iconSecondary} />}</SwapOnChange></IconButton></div></Info>
    <Info title="Reviews">{p.review_decision && <Label color={p.review_decision === 'APPROVED' ? t.green : t.text} size={14} lineHeight={21}>{reviewLabels[p.review_decision] ?? p.review_decision}</Label>}{detail.reviews?.length ? detail.reviews.map(r => <div key={r.login} style={{ ...row, minHeight: 22, marginTop: 6 }}><Avatar login={r.login} /><Label color={t.text} size={14} lineHeight={21} style={{ flexGrow: 1 }}>{r.login}</Label><Icon source={r.state === 'APPROVED' ? N.circleCheck : N.clock} size={14} color={r.state === 'APPROVED' ? t.green : t.textSecondary} /></div>) : <Label color={t.textSecondary} size={14}>No reviews yet</Label>}</Info>
    <Info title="Checks"><div style={row}>{summary.pending ? <SpinIcon testId="pr-checks-spinner" source={N.loader} size={16} color={t.warning} /> : <Icon source={N.circleCheck} size={16} color={t.green} />}<Label color={t.text} size={14} lineHeight={21}>{checksPhrase(summary)}</Label></div>{(expanded ? checks : checks.slice(0, 6)).map((check, i) => <div key={`${i}:${check.name}`} onClick={() => openUrl(check.url)} style={{ ...row, height: 28, marginTop: i === 0 ? 6 : 0, cursor: check.url ? 'pointer' : 'default' }}><CheckGlyph bucket={checkBucket(check)} /><Label color={t.textSecondary} size={14} truncate>{check.name}</Label></div>)}{checks.length > 6 && <Button variant="ghost" size="sm" style={{ alignSelf: 'flex-start' }} onClick={() => setExpanded(!expanded)}>{expanded ? 'Show less' : `Show all ${checks.length} checks`}</Button>}</Info>
    {detail.comment_count !== undefined && <Info title="Comments"><Button variant="ghost" size="sm" onClick={onTimeline} style={{ alignSelf: 'flex-start' }}>{detail.comment_count ? `${detail.comment_count} ${detail.comment_count === 1 ? 'comment' : 'comments'}` : 'No comments'}</Button></Info>}
  </div>
  return <virtual-list {...PR_SCROLL_LAYOUT} testId="pr-summary" style={{ flexGrow: 1, minHeight: 0 }} estimatedItemHeight={400}><div key="summary" style={{ ...column, padding: 24, paddingBottom: 64 }}>{width >= 832 ? <div style={{ display: 'flex', gap: 48 }}><div style={{ ...column, flexGrow: 1, gap: 24 }}>{heading}<DocumentMarkdown source={body || 'No description provided.'} theme={markdownTheme(t)} style={{ color: t.text, fontSize: 15, userSelect: 'text' }} onLinkClick={e => e.value && openUrl(e.value)} /></div>{info}</div> : <div style={{ ...column, gap: 24 }}>{heading}{info}<DocumentMarkdown source={body || 'No description provided.'} theme={markdownTheme(t)} style={{ color: t.text, fontSize: 15, userSelect: 'text' }} onLinkClick={e => e.value && openUrl(e.value)} /></div>}</div></virtual-list>
}
/** `CheckGlyph` (PrInfo.tsx:118): a running check spins (the desktop's glyph is still there; this goes one further, as asked in R4-3). */
function CheckGlyph({ bucket }: { bucket: ReturnType<typeof checkBucket> }) {
  const t = useTheme()
  if (bucket === 'failed') return <Icon source={N.x} size={14} color={t.red} />
  if (bucket === 'pending') return <SpinIcon testId="pr-check-spinner" source={N.loader} size={14} color={t.warning} />
  return <Icon source={N.circleCheck} size={14} color={bucket === 'passed' ? t.green : ink(t, 0.45)} />
}
/** The state pill. When the state changes after the pull request opened (a merge), the label swaps and the pill pops (`t-pop`, once). */
function StatePill({ pr }: { pr: PrDetailResult['pull_request'] }) {
  const t = useTheme()
  const open = pr.state === 'OPEN' && !pr.is_draft
  const label = pr.is_draft ? 'Draft' : pr.state === 'OPEN' ? 'Open' : pr.state === 'MERGED' ? 'Merged' : 'Closed'
  const pops = useCountPop(label)
  const pop = pops ? popTransform() : undefined
  const paint = pop ? { ...pop, generation: pops } : { initial: false as const, animate: { scale: 1, opacity: 1 }, transition: { duration: 0 }, generation: 0 }
  return <div testId="pr-state-pill" paintTransform={paint} style={{ ...row, height: 24, borderRadius: 12, paddingLeft: 8, paddingRight: 8, backgroundColor: open ? alpha(t.green, .12) : ink(t, .07) }}><Icon source={N.pullRequest} size={14} color={open ? t.green : t.textSecondary} /><SwapOnChange active={label} style={{ justifyContent: 'flex-start' }}><Label color={open ? t.green : pr.state === 'MERGED' ? t.link : t.textSecondary} size={14}>{label}</Label></SwapOnChange></div>
}
/** True for 1.5 s after `flash()` (a copied link, a finished merge). */
function useFlash(ms = 1500) {
  const [on, setOn] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  return [on, () => { setOn(true); clearTimeout(timer.current); timer.current = setTimeout(() => setOn(false), ms) }] as const
}
function Info({ title, children }: { title: string; children: ReactNode }) { const t = useTheme(); return <div style={{ ...column, gap: 0 }}><Label color={t.textSecondary} size={13} lineHeight={19.5} weight={500}>{title}</Label>{children}</div> }

function Avatar({ login }: { login: string }) { const t = useTheme(); return <div style={{ ...row, width: 16, height: 16, justifyContent: 'center', borderWidth: 1, borderColor: t.border, borderRadius: 8 }}><Label color={t.textSecondary} size={9} lineHeight={12}>{login.slice(0,1).toUpperCase()}</Label></div> }
