// The pull request sidebar: the verdict card, the checks and the inspector rows (reviewers, assignees, labels, auto-merge, head,
// comments). It sits outside the Summary's scrolling list, so it stays put while the description scrolls. Below 832 px it folds under
// the header: the card first, the rest behind one disclosure row.
import { useState } from 'react'
import { FILL_ISLAND } from '../../MatrixLoader.tsx'
import { Copy01Icon } from '@hugeicons/core-free-icons'
import { Icon, glyph } from '../../icons.tsx'
import { N } from '../../nav/glyphs.ts'
import { Avatar } from '../../kit/Avatar.tsx'
import { AgentAction } from '../../kit/AgentAction.tsx'
import { IconButton } from '../../kit/IconButton.tsx'
import { InspectorGroup, InspectorRow, SectionHeader } from '../../kit/Inspector.tsx'
import { StatusChip } from '../../kit/StatusChip.tsx'
import { toneColor, type Tone } from '../../kit/tone.ts'
import { SwapOnChange } from '../../motion/kit.tsx'
import { FONT_MONO } from '../../theme.ts'
import { Label, useTheme } from '../../ui.tsx'
import { checkBucket, checkWord, type CheckGroup, type PrAssessment } from '../../../../../packages/kybern-client/src/pullRequests.ts'
import type { PrDetailResult } from '../../../../../packages/kybern-client/src/types.ts'
import { copy, openUrl } from '../PrStates.tsx'
import { VerdictCard } from './VerdictCard.tsx'
import { G } from './glyphs.ts'
import { barSegments, checksSummaryLine, foldChecks, foldedWords, groupSubtitle, labelColor, REVIEWER_WORDS, reviewerRows, type ActionRequest, type ReviewerState } from './model.ts'
import { useFlash } from './useFlash.ts'

/** Auto-merge's method in words, not GitHub's enum. */
const AUTO_METHOD: Record<string, string> = { squash: 'Squash', merge: 'Merge commit', rebase: 'Rebase' }

const BUCKET_TONE = { failed: 'danger', pending: 'warning', passed: 'success', skipped: 'neutral' } as const satisfies Record<string, Tone>

/** One check's mark. Running is a still amber arc on a faint ring: only the verdict card's glyph spins (a native spinner is ~12% CPU each). */
export function CheckGlyph({ group, size = 14 }: { group: CheckGroup; size?: number }) {
  const t = useTheme()
  const color = toneColor(t, BUCKET_TONE[group.bucket])
  switch (group.bucket) {
    case 'failed': return <Icon source={G.xCircle} size={size} color={color} />
    case 'passed': return <Icon source={G.checkCircle} size={size} color={color} />
    case 'skipped': return <Icon source={G.skip} size={size} color={color} />
    default:
      if (group.checks.every(c => checkWord(c) === 'Queued')) return <Icon source={G.queued} size={size} color={color} />
      return <Icon source={G.running} size={size} color={color} />
  }
}

/** A thin bar of the check buckets, failed → running → passed → skipped, 2 px apart. */
function ChecksBar({ summary }: { summary: NonNullable<PrDetailResult['pull_request']['checks_summary']> }) {
  const t = useTheme()
  return <div testId="pr-checks-bar" style={{ display: 'flex', gap: 2, height: 4, marginTop: 4, marginBottom: 8 }}>{barSegments(summary).map(s => <div key={s.bucket} style={{ flexGrow: s.flex, flexBasis: 0, height: 4, borderRadius: 2, backgroundColor: s.bucket === 'skipped' ? (t.variant === 'dark' ? 'rgba(252, 252, 252, 0.2)' : 'rgba(13, 13, 13, 0.18)') : toneColor(t, BUCKET_TONE[s.bucket]) }} />)}</div>
}

function CheckRow({ group, canAgent, onFix }: { group: CheckGroup; canAgent: boolean; onFix: (group: CheckGroup) => void }) {
  const t = useTheme()
  const subtitle = groupSubtitle(group)
  const open = group.url ? () => openUrl(group.url) : undefined
  return (
    <div testId="pr-check-row" style={{ display: 'flex', flexDirection: 'column', marginLeft: -6, marginRight: -6 }}>
      <div onClick={open} role={open ? 'link' : undefined} aria-label={`${group.label}${subtitle ? `, ${subtitle}` : ''}`} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: 6, borderRadius: 7, ...(open ? { cursor: 'pointer', hover: { backgroundColor: t.hover } } : {}) }}>
        <div style={{ paddingTop: 2 }}><CheckGlyph group={group} /></div>
        <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
          <Label color={t.text} size={13} lineHeight={18} truncate>{group.label}</Label>
          {subtitle && <Label color={t.textTertiary} size={12} lineHeight={16}>{subtitle}</Label>}
        </div>
        {group.elapsed && <Label color={t.textTertiary} size={12} lineHeight={18} style={{ flexShrink: 0 }}>{group.elapsed}</Label>}
      </div>
      {canAgent && group.bucket === 'failed' && <div style={{ display: 'flex', paddingLeft: 28, paddingBottom: 4 }}><AgentAction testId="pr-fix-check" onClick={() => onFix(group)}>Fix with agent</AgentAction></div>}
    </div>
  )
}

function ChecksSection({ groups, summary, canAgent, onFix }: { groups: CheckGroup[]; summary: NonNullable<PrDetailResult['pull_request']['checks_summary']>; canAgent: boolean; onFix: (group: CheckGroup) => void }) {
  const t = useTheme()
  const [expanded, setExpanded] = useState(false)
  const rows = foldChecks(groups)
  const words = foldedWords(rows)
  return (
    <div testId="pr-checks" style={{ display: 'flex', flexDirection: 'column' }}>
      <SectionHeader title="Checks" trailing={checksSummaryLine(summary)} />
      <ChecksBar summary={summary} />
      {rows.open.map(g => <CheckRow key={g.key} group={g} canAgent={canAgent} onFix={onFix} />)}
      {rows.folded.length > 0 && <>
        <div testId="pr-checks-fold" role="button" aria-expanded={expanded} aria-label={words.join(', ')} onClick={() => setExpanded(!expanded)} style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 30, marginLeft: -6, marginRight: -6, paddingLeft: 6, paddingRight: 6, borderRadius: 7, cursor: 'pointer', hover: { backgroundColor: t.hover } }}>
          <Icon source={expanded ? N.chevronDown : N.chevronRight} size={12} color={t.textTertiary} />
          {rows.passed > 0 && <><Icon source={G.checkCircle} size={13} color={toneColor(t, 'success')} /><Label color={t.textSecondary} size={12.5} lineHeight={16}>{`${rows.passed} passed`}</Label></>}
          {rows.passed > 0 && rows.skipped > 0 && <Label color={t.textTertiary} size={12.5} lineHeight={16}>·</Label>}
          {rows.skipped > 0 && <><Icon source={G.skip} size={13} color={toneColor(t, 'neutral')} /><Label color={t.textSecondary} size={12.5} lineHeight={16}>{`${rows.skipped} skipped`}</Label></>}
        </div>
        {expanded && rows.folded.map(g => <CheckRow key={g.key} group={g} canAgent={false} onFix={onFix} />)}
      </>}
    </div>
  )
}

const REVIEWER_CHIP: Record<ReviewerState, { tone: Tone; icon: string }> = {
  changes_requested: { tone: 'danger', icon: G.reviewX },
  requested: { tone: 'neutral', icon: G.clock },
  approved: { tone: 'success', icon: G.reviewOk },
  commented: { tone: 'neutral', icon: G.message },
  dismissed: { tone: 'neutral', icon: G.skip },
}

function Person({ login, url }: { login: string; url?: string }) {
  const t = useTheme()
  return <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}><Avatar login={login} url={url} size={16} /><Label color={t.text} size={13} lineHeight={20} truncate>{login}</Label></div>
}

function Details({ detail, onTimeline }: { detail: PrDetailResult; onTimeline: () => void }) {
  const t = useTheme()
  const p = detail.pull_request
  const [headCopied, flashHead] = useFlash()
  const reviewers = reviewerRows(detail)
  const auto = p.auto_merge
  return <>
    <InspectorGroup>
      <InspectorRow label="Reviewers" testId="pr-reviewers">
        {reviewers.length === 0
          ? <Label color={t.textSecondary} size={13} lineHeight={20}>None yet</Label>
          : <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>{reviewers.map(r => <div key={r.login} testId={`pr-reviewer-${r.state}`} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 6, rowGap: 4, minWidth: 0 }}><Person login={r.login} url={r.avatar_url} /><StatusChip tone={REVIEWER_CHIP[r.state].tone} icon={REVIEWER_CHIP[r.state].icon}>{REVIEWER_WORDS[r.state]}</StatusChip></div>)}</div>}
      </InspectorRow>
      {!!detail.assignees?.length && <InspectorRow label="Assignees" testId="pr-assignees">{detail.assignees.map(a => <Person key={a.login} login={a.login} url={a.avatar_url} />)}</InspectorRow>}
      {!!p.labels?.length && <InspectorRow label="Labels" testId="pr-labels">{p.labels.map(l => <StatusChip key={l.name} dot={labelColor(l.color) ?? t.textSecondary}>{l.name}</StatusChip>)}</InspectorRow>}
    </InspectorGroup>
    <InspectorGroup>
      <InspectorRow label="Auto-merge" testId="pr-auto-merge">
        {auto ? <StatusChip tone="info" icon={G.auto}>{`On · ${AUTO_METHOD[auto.merge_method] ?? 'Squash'}${auto.enabled_by ? ` · ${auto.enabled_by}` : ''}`}</StatusChip> : <Label color={t.textSecondary} size={13} lineHeight={20}>Off</Label>}
      </InspectorRow>
      <InspectorRow label="Head" testId="pr-head">
        <Label color={t.text} size={12} lineHeight={20} font={FONT_MONO}>{detail.head_sha.slice(0, 7)}</Label>
        <IconButton icon={glyph(Copy01Icon)} size="sm" glyph={12} label="Copy head commit" onClick={() => { copy(detail.head_sha); flashHead() }}><SwapOnChange kind="icon" active={headCopied ? 'done' : 'copy'} style={{ width: 12, height: 12 }}>{headCopied ? <Icon source={N.check} size={12} color={t.green} /> : <Icon source={glyph(Copy01Icon)} size={12} color={t.iconSecondary} />}</SwapOnChange></IconButton>
      </InspectorRow>
      {detail.comment_count !== undefined && <InspectorRow label="Comments" testId="pr-comments" onClick={onTimeline}>
        <Label color={detail.comment_count ? t.text : t.textSecondary} size={13} lineHeight={20}>{detail.comment_count ? `${detail.comment_count} ${detail.comment_count === 1 ? 'comment' : 'comments'}` : 'None yet'}</Label>
        <Icon source={N.chevronRight} size={12} color={t.textTertiary} />
      </InspectorRow>}
    </InspectorGroup>
  </>
}

export function Sidebar({ detail, assessment, groups, compact, pending, error, canAgent, onRequest, onFixChecks, onFixGroup, onAddressFeedback, onTimeline }: {
  detail: PrDetailResult
  assessment: PrAssessment
  groups: CheckGroup[]
  /** Narrow (a dock, a small window): the rows fold behind one disclosure row under the card. */
  compact: boolean
  pending: ActionRequest | null
  error: string | null
  canAgent: boolean
  onRequest: (request: ActionRequest) => void
  onFixChecks: () => void
  onFixGroup: (group: CheckGroup) => void
  onAddressFeedback: () => void
  onTimeline: () => void
}) {
  const t = useTheme()
  const [open, setOpen] = useState(false)
  const summary = detail.pull_request.checks_summary ?? { total: detail.checks.length, passed: detail.checks.filter(c => checkBucket(c) === 'passed').length, failed: detail.checks.filter(c => checkBucket(c) === 'failed').length, pending: detail.checks.filter(c => checkBucket(c) === 'pending').length, skipped: detail.checks.filter(c => checkBucket(c) === 'skipped').length }
  const reviewers = reviewerRows(detail)
  const card = <VerdictCard assessment={assessment} pending={pending} error={error} canAgent={canAgent} onRequest={onRequest} onFixChecks={onFixChecks} onAddressFeedback={onAddressFeedback} />
  const checks = groups.length > 0 && <InspectorGroup first={!compact}><ChecksSection groups={groups} summary={summary} canAgent={canAgent} onFix={onFixGroup} /></InspectorGroup>
  const rest = <Details detail={detail} onTimeline={onTimeline} />
  if (compact) {
    const brief = [checksSummaryLine(summary).split(' · ').find(s => /running|failed/.test(s)), reviewers.find(r => r.state === 'requested') ? `${reviewers.filter(r => r.state === 'requested').length} requested` : ''].filter(Boolean).join(' · ')
    return (
      <div testId="pr-sidebar" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {card}
        <div testId="pr-details-toggle" role="button" aria-expanded={open} onClick={() => setOpen(!open)} style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 36, borderBottomWidth: open ? 0 : 1, borderColor: t.surfaceDivider, cursor: 'pointer' }}>
          <Icon source={open ? N.chevronDown : N.chevronRight} size={12} color={t.textTertiary} />
          <Label color={t.textSecondary} size={12.5} lineHeight={16}>Checks, reviewers and details</Label>
          <div style={{ flexGrow: 1 }} />
          {brief && <Label color={t.textTertiary} size={12} lineHeight={16} truncate>{brief}</Label>}
        </div>
        {open && <div style={{ display: 'flex', flexDirection: 'column' }}>{checks}{rest}</div>}
      </div>
    )
  }
  return (
    // A cached island sized by its row: a scroll frame of the description replays it instead of laying the sidebar out again.
    <div {...FILL_ISLAND} style={{ display: 'flex', flexDirection: 'column', width: 296, flexShrink: 0, minHeight: 0 }}>
      <div testId="pr-sidebar" style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0, overflowY: 'scroll', paddingLeft: 20, paddingRight: 20, paddingTop: 18, paddingBottom: 24, borderLeftWidth: 1, borderColor: t.surfaceDivider }}>
        {card}
        <div style={{ height: 6 }} />
        {checks}
        {rest}
      </div>
    </div>
  )
}
