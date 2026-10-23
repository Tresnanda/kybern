// What a row, a digit or a key does to a pending approval. One path for the card's clicks, its own key handler and the
// composer's, so the same choice sends the same RPC however it was made.
import type { ApprovalDecision, ApprovalRequest, ThreadId } from '../../../../packages/kybern-client/src/types.ts'
import { isUserInput, connectorApproval } from '../../../../packages/kybern-client/src/userInput.ts'
import { pickRequestInput } from '../../../../packages/kybern-client/src/pickRequest.ts'
import { secretRequestInput } from '../../../../packages/kybern-client/src/secretRequest.ts'
import { briefProposalInput, leadGitCardInput, settingsProposalInput } from '../../../../packages/kybern-client/src/coordinatorCards.ts'
import { sendToThread } from '../composer/store.ts'
import { kitOverlayOpen } from '../kit/AlertDialog.tsx'
import { getNav } from '../nav/store.ts'
import { getPaneIds, getPaneState, getState } from '../state.ts'
import { interrupt, reportError, respondApproval } from '../transcript/store.ts'
import { agentName, approvalCard, forwardsDeclineReason, stepHighlight, type CardModel } from './model.ts'
import { keyboardAnswer } from './Panel.tsx'
import { getCardUi, patchCardUi } from './ui.ts'

/** Whether the first pending request is a tool approval or consent the card answers with numbered rows (not a form or question). */
export function isRowCard(approval: ApprovalRequest): boolean {
  if (secretRequestInput(approval) || pickRequestInput(approval) || briefProposalInput(approval) || settingsProposalInput(approval) || leadGitCardInput(approval)) return false
  return !isUserInput(approval) || !!connectorApproval(approval)
}

/**
 * The harness of the thread that asked, wherever it is open: not the focused pane's, which in a split can be another thread with
 * another harness (its rows would map a digit to a different choice, and its decline note to the wrong path).
 */
export function threadProvider(threadId: ThreadId): string | undefined {
  for (const id of getPaneIds()) {
    const thread = getPaneState(id).open.thread
    if (thread?.id === threadId) return thread.provider.kind
  }
  return getState().threads.find((thread) => thread.id === threadId)?.provider.kind
}

export function cardFor(approval: ApprovalRequest): CardModel | null {
  return isRowCard(approval) ? approvalCard(approval, threadProvider(approval.thread_id)) : null
}

export const SEND_ERROR = 'Unable to send your choice. Check the connection and pick again.'

async function send(approval: ApprovalRequest, decision: ApprovalDecision, row: number, then?: () => void) {
  patchCardUi(approval.id, { sending: row, error: '', note: false })
  try {
    await respondApproval(approval.id, decision)
    then?.()
  } catch (e) {
    patchCardUi(approval.id, { sending: null, error: SEND_ERROR })
    reportError('Unable to respond', e)
  }
}

/** Row `index` (zero-based) was picked: a decision sends at once, Decline opens its note field. False when there is no such row. */
export function chooseRow(approval: ApprovalRequest, index: number, keyboard: boolean): boolean {
  const card = cardFor(approval)
  const row = card?.rows[index]
  if (!card || !row) return false
  if (getCardUi(approval.id).sending !== null) return true
  if (row.action.kind === 'decline') {
    patchCardUi(approval.id, { note: true, highlight: index, error: '' })
    return true
  }
  if (keyboard) keyboardAnswer()
  void send(approval, row.action.decision, index)
  return true
}

/** The decline note went in (Return): a deny that carries the note; harnesses that drop it get it as the next message. */
export function sendDecline(approval: ApprovalRequest, threadId: ThreadId, note: string, keyboard: boolean) {
  const card = cardFor(approval)
  if (!card) return
  const reason = note.trim()
  if (keyboard) keyboardAnswer()
  const decision: ApprovalDecision = reason ? { decision: 'deny', reason } : { decision: 'deny' }
  // A harness that reads the deny's `reason` must not also get the note as a message; one that drops it gets only the message.
  const provider = threadProvider(approval.thread_id)
  const forwarded = forwardsDeclineReason(approval, provider)
  void send(approval, decision, card.rows.length - 1, reason && !forwarded
    ? () => { sendToThread(threadId, { parts: [{ type: 'text', text: reason }] }, 'queue').catch((e) => reportError(`Unable to send your note to ${agentName(provider)}. Send it again as a message`, e)) }
    : undefined)
}

export function cancelTurn(threadId: ThreadId, keyboard = true) {
  if (keyboard) keyboardAnswer()
  interrupt(threadId).catch((e) => reportError('Unable to cancel the turn. Press Esc to try again', e))
}

export function moveHighlight(approval: ApprovalRequest, dir: 1 | -1): boolean {
  const card = cardFor(approval)
  if (!card) return false
  const ui = getCardUi(approval.id)
  if (ui.sending !== null || ui.note) return true
  patchCardUi(approval.id, { highlight: stepHighlight(ui.highlight, dir, card.rows.length) })
  return true
}

/** An overlay that owns Esc is open: a kit dialog, sheet, select or combobox, or the command palette. */
const overlayOwnsEscape = () => kitOverlayOpen() || getNav().paletteOpen

/**
 * Digits, ↑ ↓, Return and Esc for a row card (the card's own handler and the empty composer's). False when the key is not for
 * the card: the note field is open, the key comes from a composer of another thread (a task's follow-up composer while the pane
 * shows a different thread), or Esc belongs to an open overlay.
 */
export function handleCardKey(approval: ApprovalRequest, threadId: ThreadId, key: string): boolean {
  if (approval.thread_id !== threadId) return false
  const ui = getCardUi(approval.id)
  if (ui.note) return false
  if (/^[1-9]$/.test(key)) return chooseRow(approval, Number(key) - 1, true)
  if (key === 'up') return moveHighlight(approval, -1)
  if (key === 'down') return moveHighlight(approval, 1)
  if (key === 'enter') return chooseRow(approval, Math.min(ui.highlight, (cardFor(approval)?.rows.length ?? 1) - 1), true)
  if (key === 'escape') {
    if (overlayOwnsEscape()) return false
    if (ui.sending === null) cancelTurn(threadId)
    return true
  }
  return false
}
