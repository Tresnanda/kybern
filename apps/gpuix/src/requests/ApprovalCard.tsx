// Every tool approval and consent request (command, file edit, plan, connector, computer use, note or task change,
// permissions) as Direction B's option list: header, what is asked, numbered rows, hint line.
import { useEffect, useState } from 'react'
import type { ApprovalRequest, ThreadId } from '../../../../packages/kybern-client/src/types.ts'
import { useApp } from '../state.ts'
import { ICONS } from '../icons.tsx'
import { cancelTurn, chooseRow, handleCardKey, sendDecline } from './actions.ts'
import { CancelLink, CardShell, GLYPHS, HintText, Hints, Kbd, NoteField, OptionList, OptionRow, RequestHeader, WellFor } from './Card.tsx'
import { approvalCard, forwardsDeclineReason } from './model.ts'
import { forgetCardUi, patchCardUi, useCardUi } from './ui.ts'
import { isPrimaryNotAltGr } from '../platform/keys.ts'

/** The thread's folder as the chip shows it: relative to the home folder, tail only when long. */
export function folderLabel(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined
  const home = process.env.HOME
  const rel = home && cwd.startsWith(`${home}/`) ? cwd.slice(home.length + 1) : cwd
  return rel.length > 30 ? `…${rel.slice(-29)}` : rel
}

export function ApprovalCard({ threadId, approval, count }: { threadId: ThreadId; approval: ApprovalRequest; count: number }) {
  const provider = useApp((s) => s.open.thread?.provider.kind)
  const cwd = useApp((s) => s.open.thread?.cwd)
  const card = approvalCard(approval, provider)
  const ui = useCardUi(approval.id)
  const [note, setNote] = useState('')
  useEffect(() => () => forgetCardUi(approval.id), [approval.id])
  if (!card) return null
  const rows = card.rows
  const last = rows.length - 1
  const sending = ui.sending !== null
  const highlight = Math.min(ui.highlight, last)
  const chip = card.chip ?? (folderLabel(cwd) ? { label: folderLabel(cwd)! } : undefined)
  const toggle = () => patchCardUi(approval.id, { expanded: !ui.expanded })
  const back = () => patchCardUi(approval.id, { note: false })
  return (
    <CardShell testId="approval-panel" onKey={(e) => (isPrimaryNotAltGr(e.modifiers) && e.key === 'e' ? (toggle(), true) : handleCardKey(approval, threadId, e.key ?? ''))}>
      <RequestHeader glyph={GLYPHS[card.glyph]} title={card.title} chip={chip} chipGlyph={card.chip ? undefined : ICONS.folder} badge={count > 1 ? `1 of ${count}` : undefined} meta={card.meta} />
      <WellFor well={card.well} expanded={ui.expanded} onToggle={toggle} />
      <OptionList label={card.title}>
        {rows.map((row, i) => {
          const declining = row.action.kind === 'decline'
          const open = declining && ui.note
          return (
            <OptionRow
              key={row.id} n={i + 1} label={row.label} testId={`approval-row-${i + 1}`}
              highlighted={highlight === i && (!sending || ui.sending === i)} dim={sending && ui.sending !== i}
              sending={ui.sending === i} disabled={sending}
              onClick={() => { patchCardUi(approval.id, { highlight: i }); if (!open) chooseRow(approval, i, false) }}
            >
              {open && <NoteField agent={card.agent} value={note} onChange={setNote} onSend={() => sendDecline(approval, threadId, note, true)} onBack={back} />}
            </OptionRow>
          )
        })}
      </OptionList>
      <Hints
        error={ui.error}
        left={sending ? <HintText>Sending your choice…</HintText> : ui.note
          // A harness that drops a deny's reason gets the note as the next message (`sendDecline`): say so before it goes.
          ? <><Kbd keys={['↵']} /><HintText>{forwardsDeclineReason(approval, provider) ? 'to send your note' : 'to send it as your next message'}</HintText><HintText>·</HintText><Kbd keys={['esc']} /><HintText>to go back</HintText></>
          : <><Kbd keys={['↑', '↓']} /><HintText>to move</HintText><HintText>·</HintText><Kbd keys={['1']} /><HintText>–</HintText><Kbd keys={[String(rows.length)]} /><HintText>or</HintText><Kbd keys={['↵']} /><HintText>to choose</HintText></>}
        right={sending || ui.note ? undefined : <CancelLink onClick={() => cancelTurn(threadId, false)} />}
      />
    </CardShell>
  )
}
