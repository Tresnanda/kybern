// The one line a summoned card leaves in the transcript (sign-in, password prompt, macOS permission, a question answered by its
// deadline), drawn from the resolved approval (`requestRecord`). It never contains a secret: a password record names the command.
// An automatic answer carries "Change answer", which queues a follow-up with another option.
import type { ApprovalDecision, ApprovalRequest } from '../../../../packages/kybern-client/src/types.ts'
import { autoAnswer, changeAnswerMessage, loginRequestInput, permissionRequestInput, recordText, type RecordGlyph, type RequestRecord } from '../../../../packages/kybern-client/src/requestCards.ts'
import { questionsFor } from '../../../../packages/kybern-client/src/userInput.ts'
import { sendToThread } from '../composer/store.ts'
import { Button } from '../kit/Button.tsx'
import { Menu, MenuItem, MenuLabel } from '../nav/overlay.tsx'
import { RG, paneGlyph, serviceMark } from '../requests/glyphs.ts'
import { FONT_MONO } from '../theme.ts'
import { Label, useTheme } from '../ui.tsx'
import { T } from './glyphs.ts'
import { muted, ROW_LINE, RowIcon } from './kit.tsx'
import { reportError } from './store.ts'

function recordGlyph(glyph: RecordGlyph, approval: ApprovalRequest): string {
  switch (glyph) {
    case 'service': return serviceMark(loginRequestInput(approval)?.cli ?? '')
    case 'app': return paneGlyph(permissionRequestInput(approval)?.pane ?? '')
    case 'lock': return RG.lock
    case 'key': return RG.key
    case 'shield': return RG.shield
    case 'clock': return RG.clock
    case 'check': return T.check
    case 'question': return T.question
    case 'cross': return RG.cross
  }
}

/** Every other option of the questions the deadline answered, to queue "I'd rather have …". */
function ChangeAnswer({ approval, decision }: { approval: ApprovalRequest; decision: ApprovalDecision }) {
  const auto = autoAnswer(decision)
  const questions = questionsFor(approval).map((q) => ({ q, chose: auto?.answers[q.title] ?? '' })).filter(({ q, chose }) => q.options.some((o) => o.label !== chose))
  if (!auto || !questions.length) return null
  const queue = (question: string, chose: string, rather: string) =>
    void sendToThread(approval.thread_id, { parts: [{ type: 'text', text: changeAnswerMessage(question, chose, rather) }] }, 'queue').catch((e) => reportError('Unable to queue your answer. Try again', e))
  return (
    <Menu testId="record-change-answer-menu" align="end" minWidth={220} fit="switch" trigger={() => <Button variant="ghost" size="sm" testId="record-change-answer">Change answer</Button>}>
      {questions.map(({ q, chose }) => (
        <div key={q.id} style={{ display: 'flex', flexDirection: 'column' }}>
          {questions.length > 1 && <MenuLabel>{q.title}</MenuLabel>}
          {q.options.filter((o) => o.label !== chose).map((o) => (
            <MenuItem key={o.label} id={`${q.id}:${o.label}`} label={o.label} testId={`record-rather-${o.label}`} onSelect={() => queue(q.title, chose, o.label)} />
          ))}
        </div>
      ))}
    </Menu>
  )
}

export function RequestRecordRow({ approval, decision, record }: { approval: ApprovalRequest; decision: ApprovalDecision | null; record: RequestRecord }) {
  const t = useTheme()
  const declined = record.tone === 'declined'
  const ink = declined || record.tone === 'ended' ? muted(t) : t.textSecondary
  return (
    <div testId="request-record" aria-label={recordText(record)} style={{ display: 'flex', alignItems: 'center', gap: 8, flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
      <RowIcon box={20} size={14} source={recordGlyph(record.glyph, approval)} color={t.textTertiary} />
      <div style={{ display: 'flex', alignItems: 'center', flexGrow: 1, flexShrink: 1, minWidth: 0, overflow: 'hidden' }}>
        {record.parts.map((part, i) => part.code
          ? <div key={i} style={{ display: 'flex', alignItems: 'center', height: 18, paddingLeft: 4, paddingRight: 4, borderRadius: 5, flexShrink: 0, backgroundColor: t.variant === 'light' ? 'rgba(13, 13, 13, 0.06)' : 'rgba(252, 252, 252, 0.06)' }}>
              <Label color={t.text} size={11.5} lineHeight={16} font={FONT_MONO}>{part.text}</Label>
            </div>
          : <Label key={i} color={part.strong ? t.text : ink} size={13} lineHeight={ROW_LINE} weight={part.strong ? 500 : undefined} truncate={part.strong} style={{ flexShrink: part.strong ? 1 : 0, minWidth: part.strong ? 24 : undefined }}>{part.text}</Label>)}
        {record.detail && <Label color={t.textTertiary} size={13} lineHeight={ROW_LINE} truncate style={{ flexShrink: 1, minWidth: 0 }}>{` · ${record.detail}`}</Label>}
      </div>
      {decision && autoAnswer(decision) && <ChangeAnswer approval={approval} decision={decision} />}
    </div>
  )
}
