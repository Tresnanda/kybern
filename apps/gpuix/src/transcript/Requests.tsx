// Requests that wait on the reader, stacked on the composer like the desktop's
// `ComposerPanelStack` (`views/Thread.tsx`): tool approvals with their
// consent variants, blocking user-input questions (`UserInputPanel`,
// `QuestionSteps`) and non-blocking async questions (`AsyncQuestionPanel`).
// Copy, choices and the RPCs (`approvals.respond`, `threads.answer`,
// `threads.interrupt`) are the desktop's.
import { useEffect, type ReactNode } from 'react'
import { isUserInput, connectorApproval } from '../../../../packages/kybern-client/src/userInput.ts'
import { isElementPick, pickRequestInput } from '../../../../packages/kybern-client/src/pickRequest.ts'
import { secretRequestInput } from '../../../../packages/kybern-client/src/secretRequest.ts'
import { briefProposalInput, leadGitCardInput, settingsProposalInput } from '../../../../packages/kybern-client/src/coordinatorCards.ts'
import type { ApprovalRequest, ThreadId } from '../../../../packages/kybern-client/src/types.ts'
import { PanelEnter, PanelPresence } from '../requests/Panel.tsx'
import { SecretRequestPanel } from '../requests/Secret.tsx'
import { isVisualAnswerCard, useVisualAnswerStub, VisualAnswerStub } from '../requests/VisualAnswer.tsx'
import { PickRequestPanel } from '../requests/Pick.tsx'
import { ActivityPanels, useRequestActivity } from '../requests/Activity.tsx'
import { ComposerTray, trayVisible } from '../requests/ComposerTray.tsx'
import { loadQueue, useComposer } from '../composer/store.ts'
import { CoordinatorCard } from '../coordinator/Cards.tsx'
import { ApprovalCard } from '../requests/ApprovalCard.tsx'
import { AsyncQuestionPanel, UserInputPanel } from '../requests/Question.tsx'
import { isRowCard } from '../requests/actions.ts'
import { useApp, usePaneAccess } from '../state.ts'
import { ThemeScope, useTheme } from '../ui.tsx'
import { GlassEdge } from '../kit/GlassEdge.tsx'
import { frostBackdrop, frostFill, frostQuietTheme, useGlass } from '../platform/glass.ts'

const EMPTY: never[] = []
/** `--composer-radius` (1.2rem). */
const RADIUS = 19.2

/** Whether the first pending request replaces the composer input (`hideInput`). */
export function useBlockingRequest(): boolean {
  return useApp((s) => {
    const approval = s.open.pendingApprovals[0]
    if (!approval || !s.selectedId) return false
    return (isUserInput(approval) && !connectorApproval(approval)) || ownForm(approval)
  })
}

/** A pick of an element is a choice card (the composer stays); a file, image or window is a closed form. */
const closedPick = (a: ApprovalRequest) => { const pick = pickRequestInput(a); return !!pick && !isElementPick(pick.kind) }
const ownForm = (a: ApprovalRequest) => !!secretRequestInput(a) || closedPick(a) || !!briefProposalInput(a) || !!settingsProposalInput(a)

/** The open thread's pending approval or question, or nothing. */
export function ThreadRequests() {
  const threadId = useApp((s) => s.selectedId)
  return threadId ? <RequestStack key={threadId} threadId={threadId} /> : null
}

function RequestStack({ threadId }: { threadId: string }) {
  const pane = usePaneAccess()
  const pending = useApp((s) => s.open.pendingApprovals ?? EMPTY)
  const questions = useApp((s) => s.open.pendingQuestions ?? EMPTY)
  const running = useApp((s) => s.open.thread?.status === 'running' || s.open.thread?.status === 'awaiting-approval')
  const queued = useComposer((d) => d.queued[threadId] ?? EMPTY)
  useEffect(() => {
    if (!pane.frozen) void loadQueue(threadId)
  }, [threadId, running, pane.frozen])
  const first = pending[0] ?? null
  // A waiting visual is answered under its figure; it takes this slot only while the figure is out of view.
  const stub = useVisualAnswerStub(first)
  const approval = first && isVisualAnswerCard(first) && !stub ? null : first
  const activity = useRequestActivity(threadId)
  // Subagents, background tasks, helpers and queued follow-ups share one tray (`ComposerTray`) in this surface.
  const tray = { threadId, subagents: activity.strip?.rows ?? EMPTY, tasks: activity.active, helpers: activity.helpers, queued }
  const showTray = trayVisible(tray)
  const request = !!(approval || questions[0])
  const visible = !!(request || activity.visible || showTray)
  const closed = !!approval && ((isUserInput(approval) && !connectorApproval(approval)) || ownForm(approval))
  return (
    <PanelPresence show={visible}>{pending.length > 1 && <QueueSlivers count={pending.length} />}<StackedPanel closed={closed}>
      {/* `t-panel-enter`: each request rises into the stack as it arrives. */}
      <ActivityPanels threadId={threadId} data={activity} />
      <PanelPresence show={showTray}><PanelEnter><ComposerTray data={tray} divided={request} /></PanelEnter></PanelPresence>
      {request && <PanelEnter key={approval ? approval.id : questions[0]!.id}>
        {approval ? (
          <ApprovalRequestCard threadId={threadId} approval={approval} count={pending.length} />
        ) : (
          <AsyncQuestionPanel threadId={threadId} request={questions[0]!} count={questions.length} />
        )}
      </PanelEnter>}
    </StackedPanel></PanelPresence>
  )
}

/** Sheets peeking out above the card while more requests wait: two at most, behind the one on top. */
function QueueSlivers({ count }: { count: number }) {
  const t = useTheme()
  const g = useGlass()
  const border = g.on ? g.frostRim : t.variant === 'dark' ? 'rgba(252, 252, 252, 0.052)' : 'rgba(13, 13, 13, 0.076)'
  const fill = frostFill(g, 'composer', t.popover, 'frostStacked')
  const sliver = (width: string, opacity: number) => (
    <div testId="request-sliver" style={{ alignSelf: 'center', width, height: 5, marginBottom: -1, flexShrink: 0, opacity, backgroundColor: fill, borderWidth: 1, borderBottomWidth: 0, borderColor: border, borderTopLeftRadius: 10, borderTopRightRadius: 10 }} />
  )
  return <>{count > 2 && sliver('84%', 0.45)}{sliver('88.7%', 0.7)}</>
}

/** `chat-composer-stacked-top`: the composer's glass at half strength, top corners
 *  rounded, inset by the composer radius, open at the bottom where the input
 *  continues it. Whole-window glass frosts it like the composer (class `composer`); else it is opaque. */
export function StackedPanel({ children, closed }: { children: ReactNode; closed: boolean }) {
  const t = useTheme()
  const g = useGlass()
  const border = g.on ? g.frostRim : t.variant === 'dark' ? 'rgba(252, 252, 252, 0.052)' : 'rgba(13, 13, 13, 0.076)'
  const fill = frostFill(g, 'composer', t.popover, 'frostStacked')
  return (
    <div
      testId="thread-request"
      backdrop={frostBackdrop(g, 'composer', RADIUS - 1)}
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        // `.composer-panel-stack` (kit.css:2780) inside the `w-14/15` stacked frame:
        // min(14/15 of the column, column − 2 × radius), centred, open or closed.
        // Open, it overlaps the input by 1px (`-mb-px`) so the two read as one shell.
        width: '93.333%',
        alignSelf: 'center',
        marginBottom: closed ? 0 : -1,
        backgroundColor: fill,
        borderWidth: 1,
        borderBottomWidth: closed ? 1 : 0,
        borderColor: border,
        borderTopLeftRadius: RADIUS - 1,
        borderTopRightRadius: RADIUS - 1,
        borderBottomLeftRadius: closed ? RADIUS - 1 : 0,
        borderBottomRightRadius: closed ? RADIUS - 1 : 0,
      }}
    >
      <GlassEdge radius={RADIUS - 1} color={g.frostHighlight} />
      {/* Quiet text (counters, hints, placeholders, disabled buttons) stays readable on the frost at the glass floor. */}
      <ThemeScope theme={frostQuietTheme(t, g, fill)}>{children}</ThemeScope>
    </div>
  )
}

function ApprovalRequestCard({ threadId, approval, count }: { threadId: ThreadId; approval: ApprovalRequest; count: number }) {
  if (isVisualAnswerCard(approval)) return <VisualAnswerStub approval={approval} count={count} />
  const pick = pickRequestInput(approval)
  if (pick) return <PickRequestPanel approval={approval} input={pick} count={count} />
  const secret = secretRequestInput(approval)
  if (secret) return <SecretRequestPanel approval={approval} input={secret} count={count} />
  if (briefProposalInput(approval) || settingsProposalInput(approval) || leadGitCardInput(approval)) return <CoordinatorCard approval={approval} count={count} />
  if (isRowCard(approval)) return <ApprovalCard threadId={threadId} approval={approval} count={count} />
  return <UserInputPanel approval={approval} count={count} />
}
