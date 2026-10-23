// The numbered rows of a summoned card (sign-in, permission, SSH host key): the same `OptionRow`s, keys and decline note as an
// approval's, but each row runs its own action (`requests.act`, an answer, opening System Settings) instead of an `approvalCard`
// decision. The highlight lives in `ui.ts`, so ↑ ↓ from the empty composer move it too (`registerCardKeys`).
import { useEffect, useRef, useState } from 'react'
import type { ApprovalRequest, ThreadId } from '../../../../packages/kybern-client/src/types.ts'
import { sendToThread } from '../composer/store.ts'
import { errorText, reportError, respondApproval } from '../transcript/store.ts'
import { NoteField, OptionList, OptionRow } from './Card.tsx'
import { threadProvider } from './actions.ts'
import { agentName, forwardsDeclineReason, stepHighlight, type Part } from './model.ts'
import { keyboardAnswer } from './Panel.tsx'
import { forgetCardUi, getCardUi, patchCardUi, registerCardKeys, setCardStart, useCardUi } from './ui.ts'

export interface Choice {
  label: string | Part[]
  /** Runs the row; a thrown error's sentence shows under the rows. Absent on the decline row. */
  run?: () => Promise<void> | void
  /** The last row: opens the note field, then denies with it. */
  decline?: boolean
  testId: string
}

/** "Claude" for the copy; "The agent" when the harness is unknown. */
export const agentFor = (approval: ApprovalRequest) => {
  const name = agentName(threadProvider(approval.thread_id))
  return name.charAt(0).toUpperCase() + name.slice(1)
}

export const declineLabel = (approval: ApprovalRequest) => `Decline and tell ${agentFor(approval)} what to do instead`

/** A sentence for an action that failed: the daemon's own message when it gave one. */
export const actionFailed = (e: unknown) => errorText(e) || 'Unable to reach Kybern. Check the connection and try again.'

/** Deny the card, with the note as its reason; a harness that drops the reason gets the note as the next message. */
export async function declineWithNote(approval: ApprovalRequest, note: string) {
  const reason = note.trim()
  await respondApproval(approval.id, reason ? { decision: 'deny', reason } : { decision: 'deny' })
  const provider = threadProvider(approval.thread_id)
  if (reason && !forwardsDeclineReason(approval, provider))
    await sendToThread(approval.thread_id, { parts: [{ type: 'text', text: reason }] }, 'queue').catch((e) => reportError(`Unable to send your note to ${agentName(provider)}. Send it again as a message`, e))
}

export interface ChoiceOptions {
  /** The row highlighted first; null highlights none (Return is then inert until an arrow key picks one). */
  initial?: number | null
  /** Return never chooses (the SSH host key: trusting a host takes a digit or a click). */
  enterInert?: boolean
  /** Esc; true when handled. */
  onEscape?: () => boolean
  /** False while the rows give way to a status line or a form: only Esc is routed then. */
  active?: boolean
}

/** The rows' state and the key handler the card and the empty composer share. */
export function useChoices(approval: ApprovalRequest, threadId: ThreadId, choices: Choice[], options: ChoiceOptions = {}) {
  if (options.initial !== undefined && options.initial !== 0) setCardStart(approval.id, { highlight: options.initial ?? -1 })
  const ui = useCardUi(approval.id)
  const [note, setNote] = useState('')
  const latest = useRef({ choices, options })
  latest.current = { choices, options }
  useEffect(() => () => forgetCardUi(approval.id), [approval.id])

  const choose = (index: number, keyboard: boolean): boolean => {
    const row = latest.current.choices[index]
    if (!row) return false
    const current = getCardUi(approval.id)
    if (current.sending !== null) return true
    if (row.decline) { patchCardUi(approval.id, { note: true, highlight: index, error: '' }); return true }
    if (keyboard) keyboardAnswer()
    patchCardUi(approval.id, { sending: index, highlight: index, error: '' })
    void Promise.resolve()
      .then(() => row.run?.())
      .then(() => patchCardUi(approval.id, { sending: null }), (e) => patchCardUi(approval.id, { sending: null, error: actionFailed(e) }))
    return true
  }

  const onKey = (key: string): boolean => {
    if (approval.thread_id !== threadId) return false
    if (latest.current.options.active === false) return key === 'escape' ? latest.current.options.onEscape?.() ?? false : false
    const current = getCardUi(approval.id)
    if (current.note) return false
    const count = latest.current.choices.length
    if (/^[1-9]$/.test(key)) return choose(Number(key) - 1, true)
    if (key === 'up' || key === 'down') {
      if (current.sending !== null) return true
      const from = current.highlight < 0 ? (key === 'down' ? -1 : 0) : current.highlight
      patchCardUi(approval.id, { highlight: stepHighlight(from, key === 'down' ? 1 : -1, count) })
      return true
    }
    if (key === 'enter') {
      if (latest.current.options.enterInert || current.highlight < 0) return true
      return choose(Math.min(current.highlight, count - 1), true)
    }
    if (key === 'escape') return latest.current.options.onEscape?.() ?? false
    return false
  }

  const handler = useRef(onKey)
  handler.current = onKey
  useEffect(() => registerCardKeys(approval.id, (key) => handler.current(key)), [approval.id])

  const sendNote = async () => {
    keyboardAnswer()
    patchCardUi(approval.id, { sending: choices.length - 1, error: '', note: false })
    try { await declineWithNote(approval, note) } catch (e) { patchCardUi(approval.id, { sending: null, error: actionFailed(e) }) }
  }

  return { ui, note, setNote, choose, onKey, sendNote }
}

const parts = (label: string | Part[]): Part[] => (typeof label === 'string' ? [{ text: label }] : label)

/** The rows themselves; the decline row opens its note field in place. */
export function ChoiceRows({ approval, title, choices, state }: { approval: ApprovalRequest; title: string; choices: Choice[]; state: ReturnType<typeof useChoices> }) {
  const { ui } = state
  const sending = ui.sending !== null
  return (
    <OptionList label={title}>
      {choices.map((row, i) => {
        const open = !!row.decline && ui.note
        return (
          <OptionRow
            key={row.testId} n={i + 1} label={parts(row.label)} testId={row.testId}
            highlighted={ui.highlight === i && (!sending || ui.sending === i)} dim={sending && ui.sending !== i}
            sending={ui.sending === i} disabled={sending}
            onClick={() => { patchCardUi(approval.id, { highlight: i }); if (!open) state.choose(i, false) }}
          >
            {open && <NoteField agent={agentFor(approval)} value={state.note} onChange={state.setNote} onSend={() => void state.sendNote()} onBack={() => patchCardUi(approval.id, { note: false })} />}
          </OptionRow>
        )
      })}
    </OptionList>
  )
}
