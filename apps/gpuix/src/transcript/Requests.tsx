// Requests that wait on the reader, stacked on the composer like the desktop's
// `ComposerPanelStack` (`views/Thread.tsx`): tool approvals with their
// consent variants, blocking user-input questions (`UserInputPanel`,
// `QuestionSteps`) and non-blocking async questions (`AsyncQuestionPanel`).
// Copy, choices and the RPCs (`approvals.respond`, `threads.answer`,
// `threads.interrupt`) are the desktop's.
import { useEffect, useState, type ReactNode } from 'react'
import { toolLine } from '../../../desktop/src/lib/toolActivity.ts'
import { basename } from '../../../desktop/src/lib/format.ts'
import { splitChecklistPreview } from '../../../desktop/src/lib/agentItemTools.ts'
import {
  array,
  computerConsent,
  connectorApproval,
  connectorApprovalResponse,
  isUserInput,
  notesTasksConsent,
  questionResponse,
  questionsFor,
  record,
  string,
  type ConnectorApproval,
  type NotesTasksConsent,
} from '../../../../packages/kybern-client/src/userInput.ts'
import { secretRequestInput } from '../../../../packages/kybern-client/src/secretRequest.ts'
import { briefProposalInput, leadGitCardInput, settingsProposalInput } from '../../../../packages/kybern-client/src/coordinatorCards.ts'
import type { ApprovalDecision, ApprovalRequest, AsyncQuestionRequest, JsonValue, ThreadId } from '../../../../packages/kybern-client/src/types.ts'
import { Icon } from '../icons.tsx'
import { keyboardAnswer, PanelEnter, PanelPresence } from '../requests/Panel.tsx'
import { SecretRequestPanel } from '../requests/Secret.tsx'
import { ActivityPanels, useRequestActivity } from '../requests/Activity.tsx'
import { ComposerTray, trayVisible } from '../requests/ComposerTray.tsx'
import { loadQueue, useComposer } from '../composer/store.ts'
import { CoordinatorCard } from '../coordinator/Cards.tsx'
import { useApp, usePaneAccess } from '../state.ts'
import { FONT_MONO, FONT_UI, over } from '../theme.ts'
import { Label, useTheme } from '../ui.tsx'
import { cachedMarkdownTheme as markdownTheme } from './kit.tsx'
import { T } from './glyphs.ts'
import { GlassEdge } from '../kit/GlassEdge.tsx'
import { frostBackdrop, frostFill, useGlass } from '../platform/glass.ts'
import { alpha, CountBadge, fg, muted, Para } from './kit.tsx'
import { Button } from '../kit/Button.tsx'
import { IconButton } from '../kit/IconButton.tsx'
import { RadioRow } from '../kit/RadioRow.tsx'
import { Checkbox } from '../kit/Checkbox.tsx'
import { TextArea } from '../kit/TextArea.tsx'
import { TextField } from '../kit/Field.tsx'
import { useControls } from '../kit/controls.ts'
import { answerQuestions, errorText, interrupt, reportError, respondApproval } from './store.ts'

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

const ownForm = (a: ApprovalRequest) => !!secretRequestInput(a) || !!briefProposalInput(a) || !!settingsProposalInput(a)

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
  const approval = pending[0] ?? null
  const activity = useRequestActivity(threadId)
  // Subagents, background tasks, helpers and queued follow-ups share one tray (`ComposerTray`) in this surface.
  const tray = { threadId, subagents: activity.strip?.rows ?? EMPTY, tasks: activity.active, helpers: activity.helpers, queued }
  const showTray = trayVisible(tray)
  const request = !!(approval || questions[0])
  const visible = !!(request || activity.visible || showTray)
  const closed = !!approval && ((isUserInput(approval) && !connectorApproval(approval)) || ownForm(approval))
  return (
    <PanelPresence show={visible}><StackedPanel closed={closed}>
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

/** `chat-composer-stacked-top`: the composer's glass at half strength, top corners
 *  rounded, inset by the composer radius, open at the bottom where the input
 *  continues it. Whole-window glass frosts it like the composer (class `composer`); else it is opaque. */
export function StackedPanel({ children, closed }: { children: ReactNode; closed: boolean }) {
  const t = useTheme()
  const g = useGlass()
  const border = g.on ? g.frostRim : t.variant === 'dark' ? 'rgba(252, 252, 252, 0.052)' : 'rgba(13, 13, 13, 0.076)'
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
        backgroundColor: frostFill(g, 'composer', t.popover, 'frostStacked'),
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
      {children}
    </div>
  )
}

/** The same numbered choices for the card and the empty composer. */
export function answerApproval(approval: ApprovalRequest, threadId: ThreadId, n: number): boolean {
  const connector = connectorApproval(approval)
  if (ownForm(approval) || (isUserInput(approval) && !connector)) return false
  const gitCard = leadGitCardInput(approval)
  if (approval.tool_name === 'ExitPlanMode' && n === 2) return false
  if (gitCard && (n === 2 || (n === 1 && gitCard.op === 'merge_pr'))) return false
  const decision: ApprovalDecision | null = connector
    ? n === 1
      ? { decision: 'submit', response: connectorApprovalResponse(connector.persist.includes('session') ? 'session' : null) }
      : n === 2
        ? { decision: 'submit', response: connectorApprovalResponse(null) }
        : n === 3
          ? { decision: 'deny' }
          : null
    : n === 1
      ? { decision: 'allow_once' }
      : n === 2
        ? { decision: 'allow_always' }
        : n === 3
          ? { decision: 'deny' }
          : null
  if (!decision) {
    if (n === 4) interrupt(threadId).catch((e) => reportError('Unable to stop the turn', e))
    return n === 4
  }
  respondApproval(approval.id, decision).catch((e) => reportError('Unable to respond', e))

  return true
}

function ApprovalRequestCard({ threadId, approval, count }: { threadId: ThreadId; approval: ApprovalRequest; count: number }) {
  const connector = connectorApproval(approval)
  const answer = (n: number) => { answerApproval(approval, threadId, n) }
  const secret = secretRequestInput(approval)
  if (secret) return <SecretRequestPanel approval={approval} input={secret} count={count} />
  if (briefProposalInput(approval) || settingsProposalInput(approval) || leadGitCardInput(approval)) return <CoordinatorCard approval={approval} count={count} />
  if (connector) return <ConnectorApprovalPanel approval={approval} connector={connector} count={count} onChoose={answer} />
  const notes = notesTasksConsent(approval)
  if (notes) return <NotesTasksApprovalPanel consent={notes} count={count} onChoose={answer} />
  const computer = computerConsent(approval)
  if (computer)
    return (
      <ComputerApprovalPanel
        consent={computer}
        count={count}
        onChoose={answer}
        onAlways={() => respondApproval(approval.id, { decision: 'submit', response: { scope: 'always' } }).catch((e) => reportError('Unable to respond', e))}
      />
    )
  if (isUserInput(approval)) return <UserInputPanel approval={approval} count={count} />
  return <ApprovalPanel approval={approval} count={count} onChoose={answer} />
}

// ---- tool approval (`ApprovalPanel`) ----

function permissionBody(input: JsonValue): string {
  if (!input || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  for (const k of ['command', 'diff', 'new_string', 'content', 'patch']) {
    const v = o[k]
    if (typeof v === 'string' && v.trim()) return v
  }
  return JSON.stringify(input, null, 2)
}

/** At most `max` lines; no nested scroller in GPUIX, so the rest is counted. */
function clampLines(text: string, max: number): string {
  const lines = text.split('\n')
  if (lines.length <= max) return text
  return `${lines.slice(0, max).join('\n')}\n… ${lines.length - max} more lines`
}

function ApprovalDetail({ approval }: { approval: ApprovalRequest }) {
  const t = useTheme()
  const elevated = t.v('--color-background-elevated-secondary')
  if (approval.tool_name === 'ExitPlanMode') {
    const input = record(approval.input)
    const plan = string(input.plan)
    if (!plan) return <Para color={muted(t)} size={12} lineHeight={18} style={{ marginTop: 8 }}>Review the agent’s plan above before continuing.</Para>
    return (
      <div style={{ marginTop: 12 }}>
        <markdown source={clampLines(plan, 40)} theme={markdownTheme(t)} style={{ color: t.text, userSelect: 'text' }} />
      </div>
    )
  }
  const { verb, detail } = toolLine({ id: approval.tool_call_id ?? '', name: approval.tool_name, input: approval.input })
  const mono = (s: string, lines = 1) => (
    <div style={{ marginTop: 8, paddingLeft: 10, paddingRight: 10, paddingTop: 6, paddingBottom: 6, borderRadius: 6, backgroundColor: elevated, minWidth: 0 }}>
      <text
        style={{
          color: fg(t, 0.85),
          fontFamily: FONT_MONO,
          fontSize: 11.5,
          lineHeight: lines === 1 ? 15 : 17.875,
          userSelect: 'text',
          ...(lines === 1 ? { whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' } : {}),
        }}
      >
        {s}
      </text>
    </div>
  )
  const file = (path: string) => (
    <div style={{ display: 'flex', flexDirection: 'column', marginTop: 8, minWidth: 0 }}>
      <Label color={fg(t, 0.85)} size={12.5} weight={500} lineHeight={15} truncate>
        {basename(path)}
      </Label>
      <Label color={muted(t, 0.55)} size={10.5} lineHeight={13} font={FONT_MONO} truncate style={{ marginTop: 2 }}>
        {path}
      </Label>
    </div>
  )
  if (verb === 'Ran') return detail ? mono(detail) : null
  if (verb === 'Read' || verb === 'Edited' || verb === 'Wrote') return detail ? file(detail) : null
  const body = permissionBody(approval.input)
  return body ? mono(clampLines(body, 8), 8) : <Para color={muted(t, 0.65)} size={12} lineHeight={18} style={{ marginTop: 8 }}>Review the request to continue.</Para>
}

function approvalPrompt(a: ApprovalRequest): string {
  if (a.tool_name === 'ExitPlanMode') return 'Start implementing this plan?'
  const { verb } = toolLine({ id: a.tool_call_id ?? '', name: a.tool_name, input: a.input })
  if (verb === 'Ran') return 'Approve this command?'
  if (verb === 'Read') return 'Approve reading this file?'
  if (verb === 'Edited' || verb === 'Wrote') return 'Approve this file change?'
  return a.summary ? `${a.summary}?` : 'Grant these permissions?'
}

/** 14×12 padding (`px-3.5 py-3`). */
export function PanelBody({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div testId={testId} style={{ display: 'flex', flexDirection: 'column', paddingLeft: 14, paddingRight: 14, paddingTop: 12, paddingBottom: 12, minWidth: 0 }}>
      {children}
    </div>
  )
}

/** Prompt (13px medium, text-foreground/90) with the tool's name and the queue count. */
export function PromptLine({ prompt, aside, count }: { prompt: string; aside?: string; count: number }) {
  const t = useTheme()
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, minWidth: 0 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 6, flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
        <Para color={fg(t, 0.9)} size={13} lineHeight={17} weight={500}>
          {prompt}
        </Para>
        {aside && (
          <Label color={muted(t, 0.5)} size={11} lineHeight={17}>
            {aside}
          </Label>
        )}
      </div>
      {count > 1 && <CountBadge text={`1/${count}`} />}
    </div>
  )
}

export function ApprovalPanel({ approval, count, onChoose }: { approval: ApprovalRequest; count: number; onChoose: (n: number) => void }) {
  return (
    <PanelBody testId="approval-panel">
      <PromptLine prompt={approvalPrompt(approval)} aside={approval.tool_name} count={count} />
      <ApprovalDetail approval={approval} />
      <ApprovalActions
        primaryLabel={approval.tool_name === 'ExitPlanMode' ? 'Start implementing' : 'Approve once'}
        primaryShortcut={1}
        sessionShortcut={approval.tool_name === 'ExitPlanMode' ? undefined : 2}
        onChoose={onChoose}
      />
    </PanelBody>
  )
}

function ConnectorApprovalPanel({ approval, connector, count, onChoose }: { approval: ApprovalRequest; connector: ConnectorApproval; count: number; onChoose: (n: number) => void }) {
  const t = useTheme()
  const canPersist = connector.persist.includes('session')
  const prompt = connector.app ? `Allow ${connector.connector} to use ${connector.app}?` : connector.message || `Allow ${connector.connector}?`
  const server = string(record(approval.input).serverName) || approval.tool_name
  return (
    <PanelBody testId="approval-panel">
      <PromptLine prompt={prompt} aside={server} count={count} />
      <Para color={muted(t, 0.65)} size={12} lineHeight={19.5} style={{ marginTop: 8 }}>
        {connector.subtitle || `${connector.connector} will see this app’s window and click and type in it. Watch what it does.`}
      </Para>
      <ApprovalActions primaryLabel="Allow once" primaryShortcut={canPersist ? 2 : 1} sessionShortcut={canPersist ? 1 : undefined} onChoose={onChoose} />
    </PanelBody>
  )
}

export function Tile({ source }: { source: string }) {
  const t = useTheme()
  return (
    <div style={{ display: 'flex', width: 32, height: 32, alignItems: 'center', justifyContent: 'center', borderRadius: 8, flexShrink: 0, backgroundColor: t.v('--color-background-elevated-secondary') }}>
      <Icon source={source} size={16} color={muted(t)} />
    </div>
  )
}

function ComputerApprovalPanel({ consent, count, onChoose, onAlways }: { consent: { app: string; foreground: boolean }; count: number; onChoose: (n: number) => void; onAlways: () => void }) {
  const t = useTheme()
  return (
    <PanelBody testId="approval-panel">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <Tile source={T.laptop} />
        <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0 }}>
          <PromptLine prompt={consent.foreground ? `Let this chat take over your cursor in ${consent.app}?` : `Let this chat use ${consent.app}?`} count={count} />
          <Para color={muted(t, 0.65)} size={12} lineHeight={19.5} style={{ marginTop: 2 }}>
            {consent.foreground
              ? `${consent.app} comes to the front while the agent works. Avoid typing until it finishes.`
              : 'It works in the background. Your cursor and keyboard stay yours.'}
          </Para>
        </div>
      </div>
      <ApprovalActions
        primaryLabel="Allow once"
        primaryShortcut={1}
        sessionShortcut={2}
        onChoose={onChoose}
        always={consent.foreground ? undefined : { label: `Always allow ${consent.app}`, onChoose: onAlways }}
      />
    </PanelBody>
  )
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

function notesTasksMeta(consent: NotesTasksConsent): string[] {
  switch (consent.action) {
    case 'create_task':
      return [
        'Lands in Inbox',
        ...(consent.priority > 0 && consent.priorityLabel ? [`${consent.priorityLabel} priority`] : []),
        ...(consent.criteria > 0 ? [plural(consent.criteria, 'criterion', 'criteria')] : []),
      ]
    case 'update_note':
      return [...(consent.title ? [`New title “${consent.title}”`] : []), ...(consent.preview ? ['Replaces the text'] : [])]
    case 'claim_task':
      return ['Shows as Running while this chat works on it']
    default:
      return []
  }
}

function NotesTasksApprovalPanel({ consent, count, onChoose }: { consent: NotesTasksConsent; count: number; onChoose: (n: number) => void }) {
  const t = useTheme()
  const meta = notesTasksMeta(consent)
  const preview = splitChecklistPreview(consent.preview)
  const shown = preview.items.slice(0, 5)
  const prompt = consent.summary ? `${consent.summary}?` : consent.kind === 'task' ? 'Allow this change to a task?' : 'Allow this change to a note?'
  return (
    <PanelBody testId="approval-panel">
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <Tile source={consent.kind === 'task' ? T.listChecks : T.note} />
        <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0, paddingTop: 1 }}>
          <PromptLine prompt={prompt} count={count} />
          {meta.length > 0 && (
            <Label color={muted(t, 0.65)} size={12} lineHeight={19.5} truncate style={{ marginTop: 2 }}>
              {meta.join(' · ')}
            </Label>
          )}
          {(preview.text || shown.length > 0) && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 8, paddingLeft: 10, paddingRight: 10, paddingTop: 8, paddingBottom: 8, borderRadius: 6, backgroundColor: t.v('--color-background-elevated-secondary') }}>
              {preview.text && (
                <text style={{ color: fg(t, 0.85), fontSize: 12, lineHeight: 17.4, fontFamily: FONT_UI, lineClamp: 3 }}>{preview.text}</text>
              )}
              {shown.map((item, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: i === 0 && preview.text ? 4 : 0 }}>
                  <div style={{ width: 12, height: 12, borderRadius: 3, borderWidth: 1, borderColor: alpha(t.text, 0.45), backgroundColor: item.checked ? alpha(t.text, 0.45) : 'rgba(0, 0, 0, 0)', flexShrink: 0 }} />
                  <Label color={fg(t, 0.85)} size={12} lineHeight={17.4} truncate>
                    {item.text}
                  </Label>
                </div>
              ))}
              {preview.items.length > shown.length && (
                <Label color={muted(t, 0.65)} size={12} lineHeight={17.4} style={{ paddingLeft: 20 }}>
                  {plural(preview.items.length - shown.length, 'more criterion', 'more criteria')}
                </Label>
              )}
            </div>
          )}
        </div>
      </div>
      <ApprovalActions primaryLabel="Allow once" primaryShortcut={1} sessionShortcut={2} sessionLabel="Allow for this thread" onChoose={onChoose} />
    </PanelBody>
  )
}


function ApprovalActions({
  primaryLabel,
  primaryShortcut,
  sessionShortcut,
  sessionLabel,
  onChoose,
  always,
}: {
  primaryLabel: string
  primaryShortcut: number
  sessionShortcut?: number
  sessionLabel?: string
  onChoose: (choice: number) => void
  always?: { label: string; onChoose: () => void }
}) {
  const items: { label: string; shortcut?: number; run: () => void }[] = [
    ...(sessionShortcut !== undefined && !sessionLabel ? [{ label: 'Allow for this session', shortcut: sessionShortcut, run: () => onChoose(sessionShortcut) }] : []),
    ...(always ? [{ label: always.label, run: always.onChoose }] : []),
    { label: 'Cancel turn', shortcut: 4, run: () => onChoose(4) },
  ]
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
      <MoreMenu items={items} />
      <Button onKeyboard={keyboardAnswer} onClick={() => onChoose(3)} testId="approval-decline">
        Decline
      </Button>
      {sessionShortcut !== undefined && sessionLabel && (
        <Button onKeyboard={keyboardAnswer} onClick={() => onChoose(sessionShortcut)}>
          {sessionLabel}
        </Button>
      )}
      <Button variant="primary" onKeyboard={keyboardAnswer} onClick={() => onChoose(primaryShortcut)} testId="approval-primary">
        {primaryLabel}
      </Button>
    </div>
  )
}

/** "More approval options": a ghost icon button opening an opaque menu above it
 *  (`ComposerPickerMenuPopup side="top" align="start"`). */
function MoreMenu({ items }: { items: { label: string; shortcut?: number; run: () => void }[] }) {
  const t = useTheme()
  const g = useGlass()
  const [open, setOpen] = useState(false)
  return (
    <div style={{ position: 'relative' }}>
      <IconButton icon={T.dots} label="More approval options" onClick={() => setOpen(!open)} testId="approval-more" />
      {open && (
        <anchored side="top" align="start" gap={6} fit="switch" backdrop={frostBackdrop(g, 'menus', 12) ?? (g.on ? { blur: 0 } : undefined)}>
          <div
            onMouseDownOutside={() => setOpen(false)}
            style={{
              display: 'flex',
              flexDirection: 'column',
              minWidth: 200,
              padding: 4,
              position: 'relative',
              borderRadius: 12,
              borderWidth: 1,
              borderColor: g.on ? g.frostRim : t.border,
              backgroundColor: frostFill(g, 'menus', t.popover, 'frostMenu'),
              // A shadow under a translucent fill would darken its interior (GPUI paints it beneath the whole box).
              ...(g.on ? {} : { boxShadow: { offsetX: 0, offsetY: 8, blurRadius: 24, spreadRadius: -8, color: 'rgba(0, 0, 0, 0.28)' } }),
            }}
          >
            <GlassEdge radius={12} color={g.frostHighlight} />
            {items.map((item) => (
              <div
                key={item.label}
                testId={`approval-menu-${item.shortcut ?? item.label}`}
                onClick={() => {
                  setOpen(false)
                  item.run()
                }}
                style={{ display: 'flex', alignItems: 'center', gap: 8, height: 30, paddingLeft: 8, paddingRight: 8, borderRadius: 8, cursor: 'pointer', hover: { backgroundColor: t.buttonSecondaryHover } }}
              >
                <Label color={t.text} size={13} style={{ flexGrow: 1 }}>
                  {item.label}
                </Label>
                {item.shortcut !== undefined && (
                  <Label color={muted(t, 0.7)} size={12}>
                    {String(item.shortcut)}
                  </Label>
                )}
              </div>
            ))}
          </div>
        </anchored>
      )}
    </div>
  )
}

// ---- questions (`UserInputPanel`, `QuestionSteps`, `AsyncQuestionPanel`) ----

interface Step {
  id: string
  title: string
  answers: string[]
  secret?: boolean
}

/** Question header, body and footer (`question-panel-*` in kybern.css). */
function QuestionSteps({
  questions,
  renderQuestion,
  busy,
  error,
  hint,
  count,
  onSend,
  onDecline,
}: {
  questions: Step[]
  renderQuestion: (index: number) => ReactNode
  busy: boolean
  error: string
  hint: string
  count: number
  onSend: () => void
  onDecline?: () => void
}) {
  const t = useTheme()
  const [step, setStep] = useState(0)
  const reviewing = step === questions.length
  const ready = questions.every((q) => q.answers.some((a) => a.trim()))
  const canContinue = reviewing ? ready : !!questions[step]?.answers.some((a) => a.trim())
  const next = () => {
    if (busy || !canContinue) return
    if (reviewing) onSend()
    else setStep(step + 1)
  }
  return (
    <div testId="question-panel" style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, paddingLeft: 16, paddingRight: 16, paddingTop: 14, paddingBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icon source={T.question} size={16} color={t.text} />
          <Label color={t.text} size={12} lineHeight={18}>
            {reviewing ? 'Review answers' : 'Your input'}
          </Label>
        </div>
        <Label color={muted(t)} size={11} lineHeight={18}>
          {`${reviewing ? `${questions.length} answered` : `Question ${step + 1} of ${questions.length}`}${count > 1 ? ` · ${count} requests` : ''}`}
        </Label>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', paddingLeft: 16, paddingRight: 16, paddingTop: 4, paddingBottom: 4, opacity: busy ? 0.64 : 1 }}>
        {reviewing ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {questions.map((q, index) => (
              <div key={q.id} style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, paddingTop: 10, paddingBottom: 10 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
                  <Para color={muted(t)} size={12} lineHeight={18}>{q.title}</Para>
                  <Para color={t.text} size={12} lineHeight={18}>{q.secret ? 'Hidden answer' : q.answers.join('\n')}</Para>
                </div>
                <IconButton icon={T.pencil} label={`Edit answer to ${q.title}`} size="sm" onClick={() => setStep(index)} />
              </div>
            ))}
          </div>
        ) : (
          renderQuestion(step)
        )}
      </div>
      {error && (
        <Para color={t.red} size={11} lineHeight={16.5} style={{ paddingLeft: 16, paddingRight: 16, paddingTop: 8 }}>
          {error}
        </Para>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', gap: 10, paddingLeft: 16, paddingRight: 16, paddingTop: 12, paddingBottom: 14 }}>
        <Para color={muted(t)} size={11} lineHeight={16.5} style={{ flexGrow: 1, flexShrink: 1, flexBasis: 192 }}>
          {reviewing ? 'Check your answers before sending.' : hint}
        </Para>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {onDecline && (
            <Button variant="ghost" onKeyboard={keyboardAnswer} disabled={busy} onClick={onDecline} testId="question-decline">
              Decline
            </Button>
          )}
          {step > 0 && (
            <Button onKeyboard={keyboardAnswer} disabled={busy} onClick={() => setStep(step - 1)} icon={T.arrowLeft}>
              Previous
            </Button>
          )}
          <Button variant="primary" swap onKeyboard={keyboardAnswer} disabled={busy || !canContinue} onClick={next} iconAfter={reviewing ? undefined : T.arrowRight} testId="question-next">
            {busy ? 'Sending…' : reviewing ? (questions.length === 1 ? 'Send answer' : 'Send answers') : step === questions.length - 1 ? 'Review answers' : 'Next'}
          </Button>
        </div>
      </div>
    </div>
  )
}

/** `question-panel-option`: a single answer is a `RadioRow`; a multi-select row is the same row with a kit `Checkbox`. The selected row takes the tint. */
function Option({ label, description, checked, multiple, onPick, testId }: { label: string; description?: string; checked: boolean; multiple: boolean; onPick: () => void; testId?: string }) {
  const t = useTheme()
  const c = useControls()
  if (!multiple) return <RadioRow testId={testId} checked={checked} title={label} description={description} onSelect={onPick} style={{ marginTop: 2 }} />
  return (
    <div
      testId={testId}
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      tabIndex={0}
      onClick={onPick}
      onKeyDown={(e) => { if (e.key === 'enter' || e.key === 'space') onPick() }}
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 10, marginTop: 2, padding: 8, borderRadius: 12, cursor: 'pointer',
        backgroundColor: checked ? c.optionSelected : 'rgba(0, 0, 0, 0)',
        hover: { backgroundColor: checked ? c.optionSelected : c.ink(0.04) },
        focusVisible: { outlineWidth: 2, outlineColor: c.focus, outlineOffset: 0 },
      }}
    >
      <div style={{ display: 'flex', paddingTop: 2 }}><Checkbox checked={checked} aria-label={label} style={{ pointerEvents: 'none' }} /></div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
        <Label color={t.text} size={14} lineHeight={20} weight={500} style={{ pointerEvents: 'none' }}>{label}</Label>
        {description ? <Label color={t.textSecondary} size={13} lineHeight={19} style={{ pointerEvents: 'none' }}>{description}</Label> : null}
      </div>
    </div>
  )
}

/** `question-panel-answer` + `question-panel-field`: a kit `TextField` for one line, `TextArea` above that. */
function AnswerField({ label, value, onChange, rows = 3, testId }: { label: string; value: string; onChange: (value: string) => void; rows?: number; testId?: string }) {
  const t = useTheme()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', marginTop: 14 }}>
      <Label color={muted(t)} size={11} lineHeight={16.5} style={{ marginBottom: 6 }}>
        {label}
      </Label>
      {rows <= 1
        ? <TextField label={label} testId={testId} value={value} onChange={onChange} />
        : <TextArea label={label} testId={testId} value={value} onChange={onChange} minRows={rows} maxRows={8} />}
    </div>
  )
}

function QuestionTitle({ children }: { children: string }) {
  const t = useTheme()
  return (
    <Para color={t.text} size={13} lineHeight={19.5} weight={500} style={{ marginBottom: 10 }}>
      {children}
    </Para>
  )
}

function UserInputPanel({ approval, count }: { approval: ApprovalRequest; count: number }) {
  const t = useTheme()
  const input = record(approval.input)
  const questions = questionsFor(approval)
  const [selected, setSelected] = useState<Record<string, string[]>>({})
  const [custom, setCustom] = useState<Record<string, string>>({})
  const [value, setValue] = useState(string(input.prefill ?? input.value))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const elicitation = approval.tool_name === 'mcp_elicitation'
  const isUrl = elicitation && input.mode === 'url'
  const url = string(input.url)
  const schema = record(input.requestedSchema ?? input.requested_schema)
  const properties = record(schema.properties)
  const [fields, setFields] = useState<Record<string, string>>({})

  const submit = async (response?: unknown) => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await respondApproval(approval.id, response === undefined ? { decision: 'deny' } : { decision: 'submit', response })
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const answersFor = (q: (typeof questions)[number]) =>
    custom[q.id]?.trim() ? [...(q.multiple ? (selected[q.id] ?? []) : []), custom[q.id]!.trim()] : (selected[q.id] ?? [])

  if (questions.length)
    return (
      <QuestionSteps
        count={count}
        busy={busy}
        error={error}
        hint="The agent is waiting for your answer."
        questions={questions.map((q) => ({ id: q.id, title: q.title, secret: q.secret, answers: answersFor(q) }))}
        onDecline={() => void submit()}
        onSend={() => {
          try {
            void submit(questionResponse(approval, questions.map(answersFor)))
          } catch (e) {
            setError(errorText(e))
          }
        }}
        renderQuestion={(index) => {
          const q = questions[index]!
          return (
            <div key={q.id} style={{ display: 'flex', flexDirection: 'column' }}>
              <QuestionTitle>{q.title}</QuestionTitle>
              {q.multiple && <Para color={muted(t)} size={12} lineHeight={18}>Select all that apply.</Para>}
              {q.options.map((option, i) => (
                <Option
                  key={option.label}
                  testId={`question-option-${i}`}
                  label={option.label}
                  description={option.description}
                  multiple={q.multiple}
                  checked={(selected[q.id] ?? []).includes(option.label)}
                  onPick={() => {
                    const current = selected[q.id] ?? []
                    setSelected({
                      ...selected,
                      [q.id]: q.multiple ? (current.includes(option.label) ? current.filter((v) => v !== option.label) : [...current, option.label]) : [option.label],
                    })
                    if (!q.multiple) setCustom({ ...custom, [q.id]: '' })
                  }}
                />
              ))}
              {(q.custom || !q.options.length) && !q.secret && (
                <AnswerField
                  testId="question-answer"
                  label={q.options.length ? (q.multiple ? 'Add an answer' : 'Or write an answer') : 'Your answer'}
                  value={custom[q.id] ?? ''}
                  onChange={(v) => {
                    setCustom({ ...custom, [q.id]: v })
                    if (!q.multiple && v) setSelected({ ...selected, [q.id]: [] })
                  }}
                />
              )}
            </div>
          )
        }}
      />
    )

  // ui_select / ui_confirm / ui_input / ui_editor / mcp_elicitation forms.
  const options = array(input.options).map(String)
  const fieldEntries = Object.entries(properties)
  return (
    <div testId="question-panel" style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 16, paddingLeft: 16, paddingRight: 16, paddingTop: 14, paddingBottom: 8 }}>
        <Label color={t.text} size={12} lineHeight={18}>Input needed</Label>
        {count > 1 && <Label color={muted(t)} size={11} lineHeight={18}>{`${count} requests`}</Label>}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', paddingLeft: 16, paddingRight: 16, paddingTop: 4, paddingBottom: 4, opacity: busy ? 0.64 : 1 }}>
        <QuestionTitle>{approval.summary}</QuestionTitle>
        {approval.tool_name === 'ui_select' &&
          options.map((option) => <Option key={option} label={option} multiple={false} checked={value === option} onPick={() => setValue(option)} />)}
        {approval.tool_name === 'ui_confirm' && <Para color={t.text} size={12} lineHeight={19.5}>{string(input.message)}</Para>}
        {(approval.tool_name === 'ui_input' || approval.tool_name === 'ui_editor') && (
          <AnswerField label="Answer" value={value} onChange={setValue} rows={approval.tool_name === 'ui_editor' ? 6 : 1} />
        )}
        {elicitation && !isUrl &&
          fieldEntries.map(([key, raw]) => {
            const spec = record(raw)
            const required = array(schema.required).includes(key)
            return (
              <AnswerField
                key={key}
                label={`${string(spec.title) || key}${required ? ' *' : ' (optional)'}`}
                value={fields[key] ?? (spec.default == null ? '' : String(spec.default))}
                onChange={(v) => setFields({ ...fields, [key]: v })}
                rows={1}
              />
            )
          })}
        {isUrl && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Para color={muted(t)} size={12} lineHeight={18}>{url}</Para>
            <Para color={muted(t)} size={12} lineHeight={18}>Complete the request in your browser, then continue.</Para>
          </div>
        )}
      </div>
      {error && <Para color={t.red} size={11} lineHeight={16.5} style={{ paddingLeft: 16, paddingRight: 16, paddingTop: 8 }}>{error}</Para>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, paddingLeft: 16, paddingRight: 16, paddingTop: 12, paddingBottom: 14 }}>
        <Button variant="ghost" onKeyboard={keyboardAnswer} disabled={busy} onClick={() => void submit()}>Decline</Button>
        {approval.tool_name === 'ui_confirm' ? (
          <>
            <Button onKeyboard={keyboardAnswer} disabled={busy} onClick={() => void submit({ confirmed: false })}>Do not confirm</Button>
            <Button variant="primary" onKeyboard={keyboardAnswer} disabled={busy} onClick={() => void submit({ confirmed: true })}>Confirm</Button>
          </>
        ) : (
          <Button
            variant="primary"
            swap
            onKeyboard={keyboardAnswer}
            disabled={busy || (approval.tool_name === 'ui_select' && !value)}
            onClick={() => {
              if (!elicitation) return void submit({ value })
              const content: Record<string, unknown> = {}
              for (const [key, raw] of fieldEntries) {
                const spec = record(raw)
                const v = fields[key] ?? (spec.default == null ? '' : String(spec.default))
                if (!v && !array(schema.required).includes(key)) continue
                content[key] = spec.type === 'boolean' ? v === 'true' : spec.type === 'number' || spec.type === 'integer' ? Number(v) : v
              }
              void submit({ action: 'accept', ...(isUrl ? {} : { content }) })
            }}
          >
            {busy ? 'Sending…' : 'Submit'}
          </Button>
        )}
      </div>
    </div>
  )
}

/** Async questions stay open while the agent works; picking never submits. */
function AsyncQuestionPanel({ threadId, request, count }: { threadId: ThreadId; request: AsyncQuestionRequest; count: number }) {
  const [answers, setAnswers] = useState<Record<number, string>>({})
  const [custom, setCustom] = useState<Record<number, boolean>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const ready = request.questions.every((_, i) => answers[i]?.trim())
  return (
    <QuestionSteps
      count={count}
      busy={busy}
      error={error}
      hint="The agent keeps working while you answer."
      questions={request.questions.map((q, i) => ({ id: String(i), title: q.title, answers: answers[i]?.trim() ? [answers[i]!] : [] }))}
      onSend={async () => {
        if (busy || !ready) return
        setBusy(true)
        setError('')
        try {
          await answerQuestions(threadId, request.id, request.questions.map((_, i) => answers[i]!.trim()))
        } catch (e) {
          setError(errorText(e))
        } finally {
          setBusy(false)
        }
      }}
      renderQuestion={(index) => {
        const q = request.questions[index]!
        return (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <QuestionTitle>{q.title}</QuestionTitle>
            {q.options.map((option, i) => (
              <Option
                key={i}
                label={option}
                multiple={false}
                checked={!custom[index] && answers[index] === option}
                onPick={() => {
                  setAnswers({ ...answers, [index]: option })
                  setCustom({ ...custom, [index]: false })
                }}
              />
            ))}
            <AnswerField
              label={q.options.length ? 'Or write an answer' : 'Your answer'}
              value={custom[index] ? (answers[index] ?? '') : ''}
              onChange={(v) => {
                setAnswers({ ...answers, [index]: v })
                setCustom({ ...custom, [index]: true })
              }}
            />
          </div>
        )
      }}
    />
  )
}
