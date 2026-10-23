// Visuals that talk back (ADE-69, V1). An agent publishes a visual with `await_answer`; its tool call waits on a
// `kybern_visual_answer` card. The page drafts a value as the reader chooses (`kybern.answer.draft`), and Kybern draws
// the one submit control: the answer bar under the figure. Typing a message instead answers as `replied`; Skip denies.
// While the figure is out of view, a stub above the composer says what is waiting. Once answered, the bar becomes a
// one-line receipt and the picture is redrawn in the page's answered look (`kybern-visual-lock`).
import { useSyncExternalStore } from 'react'
import { DashboardSquare01Icon, Hold04Icon, SlidersHorizontalIcon, ArrowTurnBackwardIcon, ArrowUp02Icon, Cancel01Icon } from '@hugeicons/core-free-icons'
import type { ApprovalRequest, HtmlVisual, JsonValue, UserMessage, VisualAnswerRecord } from '../../../../packages/kybern-client/src/types.ts'
import { ANSWER_COPY, answerAction, answerHint, answerKind, answerReceipt, answerStubTitle, answerTitle, draftLabel, lateAnswerMessage, visualAnswerInput, type AnswerKind } from '../../../../packages/kybern-client/src/visualAnswer.ts'
import { getState, useApp } from '../state.ts'
import { respondApproval } from '../transcript/store.ts'
import { agentName } from './model.ts'
import { Label, useTheme } from '../ui.tsx'
import { useControls } from '../kit/controls.ts'
import { Button } from '../kit/Button.tsx'
import { Kbd } from '../kit/Kbd.tsx'
import { Spinner } from '../kit/Spinner.tsx'
import { glyph, Icon } from '../icons.tsx'
import { T } from '../transcript/glyphs.ts'
import { useGlass } from '../platform/glass.ts'
import { HOVER_FADE, EASE } from '../motion/kit.tsx'

const GLYPH: Record<AnswerKind, string> = { choice: glyph(DashboardSquare01Icon), settings: glyph(SlidersHorizontalIcon), answer: glyph(Hold04Icon) }
const REPLY = glyph(ArrowTurnBackwardIcon), SKIPPED = glyph(Cancel01Icon), UP = glyph(ArrowUp02Icon)

// ---- module state: drafts and which figures are on screen (the composer and the stub read them) ----

type Draft = { value: JsonValue; label: string }
const drafts = new Map<string, Draft>()
const interacted = new Set<string>()
const onScreen = new Map<string, boolean>()
const reveals = new Map<string, () => void>()
const sending = new Map<string, 'sending' | 'error'>()
const listeners = new Set<() => void>()
let version = 0
const changed = () => { version++; for (const l of listeners) l() }
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
const useVersion = () => useSyncExternalStore(subscribe, () => version)

export function setAnswerOnScreen(visualId: string, visible: boolean) {
  if ((onScreen.get(visualId) ?? false) === visible) return
  if (visible) onScreen.set(visualId, true); else onScreen.delete(visualId)
  changed()
}
/** The figure registers how to scroll itself into view, for the stub's Show. */
export function registerAnswerReveal(visualId: string, reveal: () => void) { reveals.set(visualId, reveal); return () => { if (reveals.get(visualId) === reveal) reveals.delete(visualId) } }

/** The open thread's waiting visual card, if any. */
export function pendingVisualAnswer(threadId: string): ApprovalRequest | null {
  const open = getState().open
  if (open.thread?.id !== threadId) return null
  return open.pendingApprovals.find(a => !!visualAnswerInput(a)) ?? null
}
export const isVisualAnswerCard = (approval: ApprovalRequest | null | undefined) => !!visualAnswerInput(approval)

/** A message typed while a visual waits answers it in words (`replied`). Text only: anything else goes as a message. */
export function replyToVisual(approval: ApprovalRequest, message: UserMessage): Promise<void> | null {
  if (!message.parts.every(part => part.type === 'text')) return null
  const reply = message.parts.map(part => part.type === 'text' ? part.text : '').join('').trim()
  if (!reply) return null
  return respondApproval(approval.id, { decision: 'submit', response: { reply } })
}

// ---- the figure's answer state ----

export interface VisualAsk {
  /** A card is waiting and nothing is recorded yet. */
  waiting: boolean
  /** The agent stopped waiting (timed out) and the reader has chosen since: send it as a message. */
  late: boolean
  kind: AnswerKind
  agent: string
  draftLabel: string | null
  state: 'idle' | 'sending' | 'error'
  approval: ApprovalRequest | null
  interacted: () => void
  draft: (value: unknown, label?: string) => void
  submit: () => void
  skip: () => void
}

export function useVisualAnswer(visual: HtmlVisual, record: VisualAnswerRecord | null): VisualAsk {
  useVersion()
  const approval = useApp(s => s.open.pendingApprovals.find(a => visualAnswerInput(a)?.visual_id === visual.id) ?? null)
  const provider = useApp(s => s.open.thread?.provider.kind)
  const agent = agentName(provider)
  const kind = answerKind(visual.ask?.schema ?? null)
  const draft = drafts.get(visual.id) ?? null
  const state = sending.get(visual.id) ?? 'idle'
  const waiting = !!visual.ask && !!approval && !record
  const late = !!visual.ask && record?.status === 'timed_out' && !!draft
  const send = async () => {
    const current = drafts.get(visual.id)
    if (!current || sending.get(visual.id) === 'sending') return
    sending.set(visual.id, 'sending'); changed()
    try {
      if (approval && !record) await respondApproval(approval.id, { decision: 'submit', response: { answer: current.value, label: current.label } })
      else {
        const { sendToThread } = await import('../composer/store.ts')
        await sendToThread(approval?.thread_id ?? getState().open.thread!.id, { parts: [{ type: 'text', text: lateAnswerMessage(visual.title, current.label) }] }, 'send')
        drafts.delete(visual.id)
      }
      sending.delete(visual.id)
    } catch { sending.set(visual.id, 'error') }
    changed()
  }
  return {
    waiting, late, kind, agent, approval, state,
    draftLabel: draft?.label ?? null,
    interacted: () => { interacted.add(visual.id) },
    draft: (value, label) => {
      // Only a page the reader has touched may draft: a page cannot pick an answer by itself.
      if (!interacted.has(visual.id) || !visual.ask || (record && record.status !== 'timed_out')) return
      if (value === null || value === undefined) drafts.delete(visual.id)
      else drafts.set(visual.id, { value: value as JsonValue, label: draftLabel(value as JsonValue, label) })
      if (sending.get(visual.id) === 'error') sending.delete(visual.id)
      changed()
    },
    submit: () => void send(),
    skip: () => { if (approval) void respondApproval(approval.id, { decision: 'deny', reason: 'skipped' }).catch(() => { sending.set(visual.id, 'error'); changed() }) },
  }
}

/** Under a waiting figure, in place of the caption: what is asked, the hint, Skip and the one send button. */
export function AnswerBar({ ask, live }: { ask: VisualAsk; live: boolean }) {
  const t = useTheme(), c = useControls(), g = useGlass()
  const light = t.variant === 'light'
  const sendingNow = ask.state === 'sending'
  const ready = !!ask.draftLabel && !sendingNow
  const hint = ask.state === 'error' ? ANSWER_COPY.sendError : ask.late ? `${ask.agent} stopped waiting. Send ${ask.draftLabel} as a message.` : answerHint(ask.kind, ask.draftLabel)
  return <div testId="visual-answer-bar" role="group" aria-label={answerTitle(ask.kind, ask.agent)} tabIndex={0}
    onKeyDown={e => { if (e.key === 'enter' && ready) ask.submit() }}
    style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: live ? 16 : 10, paddingTop: 8, paddingBottom: 8, paddingLeft: 12, paddingRight: 8, borderRadius: 12,
      backgroundColor: g.on ? 'rgba(51, 134, 214, 0.13)' : c.acc(light ? 0.055 : 0.09),
      boxShadow: { offsetX: 0, offsetY: 0, blurRadius: 0, spreadRadius: 1, color: c.acc(light ? 0.18 : 0.24), inset: true },
      focusVisible: { outlineWidth: 2, outlineColor: c.focus, outlineOffset: 2 } }}>
    <div style={{ display: 'flex', width: 24, height: 24, alignItems: 'center', justifyContent: 'center', borderRadius: 7, flexShrink: 0, backgroundColor: c.acc(light ? 0.12 : 0.2) }}>
      <Icon source={GLYPH[ask.kind]} size={14} color={c.accentFg} />
    </div>
    <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
      <Label color={t.text} size={13} lineHeight={18} weight={600} truncate>{ask.late ? `${ask.agent} went on without your choice` : answerTitle(ask.kind, ask.agent)}</Label>
      <div testId="visual-answer-hint" style={{ display: 'flex', minWidth: 0 }}><Label color={ask.state === 'error' ? t.red : t.textSecondary} size={12} lineHeight={17} truncate>{hint}</Label></div>
    </div>
    {!sendingNow && !ask.late && <Button size="sm" variant="ghost" testId="visual-answer-skip" style={{ height: 28 }} onClick={ask.skip}>{ANSWER_COPY.skip}</Button>}
    <div paintTransform={{ initial: false, animate: { opacity: ready || sendingNow ? 1 : 0.45 }, transition: { duration: HOVER_FADE.duration, ease: [...EASE.out] as [number, number, number, number] }, retain: true }} style={{ display: 'flex', flexShrink: 0 }}>
      <div testId="visual-answer-send" role="button" tabIndex={ready ? 0 : -1} aria-disabled={!ready || undefined} aria-label={answerAction(ask.kind, ask.draftLabel)}
        onClick={ready ? ask.submit : undefined} onKeyDown={e => { if (ready && (e.key === 'enter' || e.key === 'space')) ask.submit() }}
        style={{ display: 'flex', alignItems: 'center', gap: 6, height: 28, paddingLeft: 10, paddingRight: 6, borderRadius: 8, cursor: ready ? 'pointer' : 'default',
          backgroundColor: c.acc(light ? 0.14 : 0.3), ...(ready ? { hover: { backgroundColor: c.acc(light ? 0.2 : 0.38) }, active: { backgroundColor: c.acc(light ? 0.24 : 0.24) } } : {}),
          focusVisible: { outlineWidth: 2, outlineColor: c.focus, outlineOffset: 1 } }}>
        {sendingNow && <Spinner size={12} color={c.accentFg} />}
        <Label color={c.accentFg} size={12} lineHeight={16} weight={600}>{sendingNow ? ANSWER_COPY.sending : answerAction(ask.kind, ask.draftLabel)}</Label>
        {!sendingNow && <div style={{ display: 'flex', borderRadius: 4, boxShadow: { offsetX: 0, offsetY: 0, blurRadius: 0, spreadRadius: 1, color: c.acc(0.5), inset: true } }}><Kbd keys={['↵']} /></div>}
      </div>
    </div>
  </div>
}

/** The one-line record under an answered visual: ✓ You chose …, ↩ You replied instead, × Skipped. */
export function AnswerReceipt({ record, ask, title }: { record: VisualAnswerRecord; ask: VisualAsk; title: string }) {
  const t = useTheme()
  const light = t.variant === 'light'
  const at = new Date(record.at)
  const time = Number.isNaN(at.getTime()) ? '' : at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const [mark, color] = record.status === 'answered' ? [T.check, light ? '#1a7f37' : '#7ad48a'] : record.status === 'replied' ? [REPLY, t.textTertiary] : [SKIPPED, t.textTertiary]
  return <div testId="visual-answer-receipt" data-status={record.status} style={{ display: 'flex', alignItems: 'center', gap: 6, height: 24, marginTop: 8, minWidth: 0 }}>
    <Icon source={mark} size={14} color={color} />
    <Label color={t.text} size={12} lineHeight={16} weight={500} truncate style={{ flexShrink: 1, minWidth: 0 }}>{answerReceipt(record, ask.kind, ask.agent)}</Label>
    <Label color={t.textTertiary} size={12} lineHeight={16} truncate style={{ flexShrink: 2, minWidth: 0 }}>{`· ${title}`}</Label>
    {time && <Label color={t.textTertiary} size={12} lineHeight={16} style={{ flexShrink: 0, fontVariantNumeric: 'tabular-nums' } as never}>{`· ${time}`}</Label>}
  </div>
}

/** Whether the waiting visual's stub belongs above the composer: only while its figure is out of view. */
export function useVisualAnswerStub(approval: ApprovalRequest | null): boolean {
  useVersion()
  const input = visualAnswerInput(approval)
  return !!input && !onScreen.get(input.visual_id)
}

/** Above the composer while the waiting figure is scrolled away (the StackedPanel slot). */
export function VisualAnswerStub({ approval, count }: { approval: ApprovalRequest; count: number }) {
  const t = useTheme(), c = useControls()
  const input = visualAnswerInput(approval)!
  const provider = useApp(s => s.open.thread?.provider.kind)
  const kind = answerKind(input.schema ?? null)
  return <div testId="visual-answer-stub" style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 12, paddingBottom: 10, paddingLeft: 14, paddingRight: 10 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
      <div style={{ display: 'flex', width: 24, height: 24, alignItems: 'center', justifyContent: 'center', borderRadius: 7, flexShrink: 0, backgroundColor: c.acc(t.variant === 'light' ? 0.12 : 0.2) }}>
        <Icon source={GLYPH[kind]} size={14} color={c.accentFg} />
      </div>
      <Label color={t.text} size={14} lineHeight={20} weight={600} truncate style={{ flexGrow: 1, flexShrink: 1, minWidth: 0 }}>{answerStubTitle(kind, agentName(provider), input.title)}</Label>
      {count > 1 && <Label color={c.accentFg} size={11.5} lineHeight={14} weight={600}>{`1 of ${count}`}</Label>}
      <Button size="sm" variant="secondary" testId="visual-answer-show" icon={UP} style={{ height: 26 }} onClick={() => reveals.get(input.visual_id)?.()}>{ANSWER_COPY.show}</Button>
    </div>
    <Label color={t.textTertiary} size={12} lineHeight={17} style={{ marginLeft: 34 }}>{ANSWER_COPY.stubHint}</Label>
  </div>
}
