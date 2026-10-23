// What the pick card does for an element pick: start the overlay in the page, wait for the click, crop the element, and answer.
// One pick at a time per card. The page can also end it (Esc, "Stop" in its own bar); the card follows either way.
import type { ApprovalRequest } from '../../../../packages/kybern-client/src/types.ts'
import { showPreview } from '../preview/store.ts'
import { openTab } from '../tabs/open.ts'
import { respondApproval } from '../transcript/store.ts'
import { captureElement, liveHosts, onPickMessage, startPicking, stopPicking, type PickSource } from './hub.ts'
import { getPickUi, patchPickUi } from './store.ts'

const running = new Map<string, { hosts: string[]; off: () => void; source: PickSource; threadId: string }>()

/** The Preview is a tab of the thread: while picking it shows, and the card (in the chat) comes back when the pick ends. */
const backToChat = (threadId: string) => { openTab(threadId, { kind: 'chat' }) }

/** Stop watching the page and take the overlay down (the card closed, or the pick ended). */
export function endPick(approvalId: string) {
  const entry = running.get(approvalId)
  if (!entry) return
  running.delete(approvalId)
  entry.off()
  for (const host of entry.hosts) stopPicking(host)
  if (entry.source === 'preview') backToChat(entry.threadId)
}

const NO_PAGE: Record<PickSource, string> = {
  preview: 'Open a page in the Preview, then pick again.',
  visual: 'No visual is showing in this chat. Scroll to it and click it once, then pick again.',
}

/** Row 1: draw the overlay in the Preview or every showing visual of the thread. `label` is the page's bar ("Click the element Claude means"). */
export async function beginElementPick(approval: ApprovalRequest, source: PickSource, label: string) {
  endPick(approval.id)
  const threadId = approval.thread_id
  if (source === 'preview') showPreview(threadId, false)
  const hosts = liveHosts(threadId, source)
  if (!hosts.length) { patchPickUi(approval.id, { phase: 'ask', error: NO_PAGE[source] }); return }
  patchPickUi(approval.id, { phase: 'picking', error: '', picked: null })
  const off = onPickMessage(message => {
    if (!hosts.includes(message.hostId) || message.event === 'anchor') return
    if (message.event === 'cancelled') { endPick(approval.id); patchPickUi(approval.id, { phase: 'ask' }); return }
    const payload = message.payload
    if (!payload) return
    // The other documents leave picking; this one already took its overlay down.
    endPick(approval.id)
    patchPickUi(approval.id, { phase: 'capturing', picked: { payload, shot: null } })
    void captureElement(message.hostId, payload.box).then(shot => {
      if (getPickUi(approval.id).phase === 'capturing') patchPickUi(approval.id, { phase: 'confirm', picked: { payload, shot } })
    })
  })
  running.set(approval.id, { hosts, off, source, threadId })
  try { await Promise.all(hosts.map(host => startPicking(host, label))) }
  catch { endPick(approval.id); patchPickUi(approval.id, { phase: 'ask', error: 'The page is not ready to pick from. Reload it, then pick again.' }) }
}

/** Esc or "Stop picking": back to the first rows, nothing sent. */
export function stopElementPick(approvalId: string) {
  endPick(approvalId)
  patchPickUi(approvalId, { phase: 'ask' })
}

export async function sendElementPick(approval: ApprovalRequest) {
  const { picked } = getPickUi(approval.id)
  if (!picked) return
  patchPickUi(approval.id, { phase: 'sending', error: '' })
  try {
    await respondApproval(approval.id, { decision: 'submit', response: { ...picked.payload, ...(picked.shot ? { screenshot_asset: picked.shot.assetId } : {}) } })
  } catch {
    patchPickUi(approval.id, { phase: 'confirm', error: 'Unable to send your choice. Check the connection and try again.' })
  }
}

export async function declinePick(approval: ApprovalRequest) {
  endPick(approval.id)
  try { await respondApproval(approval.id, { decision: 'deny' }) }
  catch { patchPickUi(approval.id, { phase: 'ask', error: 'Unable to send your answer. Check the connection and try again.' }) }
}
