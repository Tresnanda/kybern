// The verdict card: the top of the pull request sidebar. Everything on it (tone, title, detail, blockers, "Next:", the main button and
// its menu) comes from `assessPullRequest`, the one reading the list rows share, so a pull request never says "ready" here and
// "blocked" there. Merge lives only in this card. While checks run, only this card's glyph turns (slowly): the check rows hold a still arc.
import { Fragment } from 'react'
import { Icon } from '../../icons.tsx'
import { SpinIcon } from '../../kit/Spin.tsx'
import { N } from '../../nav/glyphs.ts'
import { MenuItem, MenuSeparator } from '../../nav/overlay.tsx'
import { AgentAction } from '../../kit/AgentAction.tsx'
import { Button } from '../../kit/Button.tsx'
import { Card } from '../../kit/Card.tsx'
import { SplitButton } from '../../kit/SplitButton.tsx'
import { toneColor, type Tone } from '../../kit/tone.ts'
import { Label, useTheme } from '../../ui.tsx'
import type { BlockerKind, PrAssessment } from '../../../../../packages/kybern-client/src/pullRequests.ts'
import { busyLabel, requestForMenu, requestForPrimary, type ActionRequest } from './model.ts'
import { G } from './glyphs.ts'

const BLOCKER_ICON: Record<BlockerKind, { source: string; tone: Tone }> = {
  conflicts: { source: G.conflict, tone: 'danger' },
  behind: { source: G.update, tone: 'warning' },
  checks_failed: { source: G.xCircle, tone: 'danger' },
  changes_requested: { source: G.reviewX, tone: 'danger' },
  review_required: { source: G.clock, tone: 'warning' },
  branch_protection: { source: G.alert, tone: 'warning' },
}
const PRIMARY_ICON: Record<string, string> = { merge: G.merge, auto_merge: G.auto, cancel_auto_merge: G.xCircle, update_branch: G.update, resolve_in_conversation: G.agent, ready_for_review: G.pr }

/** The verdict's own glyph; a running wait is the one thing on the page that spins. */
function VerdictGlyph({ a }: { a: PrAssessment }) {
  const t = useTheme()
  const color = toneColor(t, a.severity)
  if (a.tone === 'ready') return <Icon source={G.checkCircle} size={16} color={color} />
  if (a.tone === 'conflict') return <Icon source={G.conflict} size={16} color={color} />
  if (a.tone === 'blocked') return <Icon source={a.severity === 'danger' ? G.xCircle : G.alert} size={16} color={color} />
  if (a.tone === 'draft') return <Icon source={G.draft} size={16} color={color} />
  if (a.tone === 'merged') return <Icon source={G.merge} size={16} color={t.link} />
  if (a.tone === 'closed') return <Icon source={G.xCircle} size={16} color={color} />
  if (a.tone === 'waiting' && a.severity === 'info') return <Icon source={G.auto} size={16} color={color} />
  if (a.tone === 'waiting') return <SpinIcon testId="pr-verdict-spinner" source={G.running} size={16} color={color} periodMs={1600} />
  return <Icon source={G.clock} size={16} color={color} />
}

export function VerdictCard({ assessment: a, pending, error, canAgent, onRequest, onFixChecks, onAddressFeedback }: {
  assessment: PrAssessment
  /** The request in flight: its button reads "Merging…" and nothing else can be pressed. */
  pending: ActionRequest | null
  error: string | null
  /** Agents need a conversation to check the branch out into; a group member's pull request has none yet. */
  canAgent: boolean
  onRequest: (request: ActionRequest) => void
  onFixChecks: () => void
  onAddressFeedback: () => void
}) {
  const t = useTheme()
  const request = requestForPrimary(a.primary)
  const agentPrimary = request?.kind === 'agent'
  const primaryOff = !request || pending !== null || (agentPrimary && !canAgent)
  const label = pending ? busyLabel(pending) : a.primary.label
  const icon = PRIMARY_ICON[a.primary.kind]
  const agentBlockers = a.blockers.filter(b => b.kind === 'checks_failed' || b.kind === 'changes_requested')
  const menu = a.menu.length > 0 && <>
    {a.menu.map((item, i) => <Fragment key={`${item.kind}:${item.method ?? ''}`}>{item.destructive && i > 0 && <MenuSeparator />}<MenuItem id={`${item.kind}:${item.method ?? ''}`} testId={`pr-menu-${item.kind}${item.method ? `-${item.method}` : ''}`} label={item.label} destructive={item.destructive} disabled={pending !== null} onSelect={() => onRequest(requestForMenu(item))} /></Fragment>)}
  </>
  return (
    <Card tone={a.severity} testId="pr-verdict">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <VerdictGlyph a={a} />
        <Label color={t.text} size={14} lineHeight={20} weight={600}>{a.title}</Label>
      </div>
      {a.blockers.length > 1
        ? <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>{a.blockers.map(b => {
          const icon = BLOCKER_ICON[b.kind]
          return <div key={b.kind} style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 28 }}><Icon source={icon.source} size={14} color={toneColor(t, icon.tone)} /><Label color={t.text} size={12.5} lineHeight={17}>{b.label}</Label></div>
            {canAgent && b.kind === 'checks_failed' && <div style={{ display: 'flex', paddingLeft: 22, paddingBottom: 6 }}><AgentAction testId="pr-fix-checks" onClick={onFixChecks}>Fix with agent</AgentAction></div>}
            {canAgent && b.kind === 'changes_requested' && <div style={{ display: 'flex', paddingLeft: 22, paddingBottom: 6 }}><AgentAction testId="pr-address-feedback" onClick={onAddressFeedback}>Address feedback</AgentAction></div>}
          </div>
        })}</div>
        : <>
          <Label color={t.textSecondary} size={12.5} lineHeight={18}>{a.detail}</Label>
          {canAgent && agentBlockers[0]?.kind === 'checks_failed' && <div style={{ display: 'flex' }}><AgentAction testId="pr-fix-checks" onClick={onFixChecks}>Fix with agent</AgentAction></div>}
          {canAgent && agentBlockers[0]?.kind === 'changes_requested' && <div style={{ display: 'flex' }}><AgentAction testId="pr-address-feedback" onClick={onAddressFeedback}>Address feedback</AgentAction></div>}
        </>}
      {a.next && <div style={{ display: 'flex', gap: 4, alignItems: 'flex-start' }}><Label color={t.text} size={12.5} lineHeight={18} weight={600}>Next:</Label><Label color={t.text} size={12.5} lineHeight={18} style={{ flexShrink: 1, minWidth: 0 }}>{a.next}</Label></div>}
      {error && <Label color={t.red} size={12.5} lineHeight={18}>{error}</Label>}
      {a.primary.label && (a.menu.length > 0
        ? <SplitButton block variant={a.primary.kind === 'cancel_auto_merge' || a.primary.kind === 'none' ? 'secondary' : 'primary'} testId="pr-verdict-primary" menuTestId="pr-verdict-menu" menuLabel="Merge options" keepMenu icon={icon && !primaryOff ? icon : undefined} disabled={primaryOff} onClick={() => request && onRequest(request)} menu={menu}>{label}</SplitButton>
        : <Button block variant={request ? 'primary' : 'secondary'} testId="pr-verdict-primary" icon={icon} disabled={primaryOff} onClick={() => request && onRequest(request)}>{label}</Button>)}
    </Card>
  )
}
