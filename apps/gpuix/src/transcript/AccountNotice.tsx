// The lines an account switch leaves in a thread: "Switched to Work · Undo" and "Waiting for Work until 15:00 · Cancel".
// One line each; the words come from the daemon. Only the newest switch offers Undo, and only while the thread is still on
// the account it switched to; a wait offers Cancel until it ends.
import { useState } from 'react'
import type { AccountNotice } from '../../../../packages/kybern-client/src/accountNotices.ts'
import type { ThreadId } from '../../../../packages/kybern-client/src/types.ts'
import { loadTarget } from '../composer/store.ts'
import { N } from '../nav/glyphs.ts'
import { toastProblem } from '../problems/toast.ts'
import { keyboardAnswer } from '../requests/Panel.tsx'
import { threadClient, useApp } from '../state.ts'
import { useTreeSlot } from '../tree/Tree.tsx'
import { Label, useTheme } from '../ui.tsx'
import { fg, muted, Para, ROW_LINE, RowIcon } from './kit.tsx'

export function AccountNoticeRow({ threadId, text, notice }: { threadId: ThreadId; text: string; notice: AccountNotice }) {
  const t = useTheme()
  const tree = useTreeSlot()
  const provider = useApp((s) => (s.open.thread?.id === threadId ? s.open.thread.provider : s.threads.find((thread) => thread.id === threadId)?.provider))
  const undo = notice.kind === 'account_switched' && !notice.superseded && !!provider && provider.kind === notice.to.kind && provider.instance === notice.to.instance
  const waiting = notice.kind === 'account_wait'
  const icon = notice.kind === 'account_switched' ? N.handoff : notice.kind === 'account_wait_ended' && notice.cancelled ? N.x : N.clock
  const [busy, setBusy] = useState(false)
  const run = (action: string, work: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true)
    void work().catch((error) => toastProblem(error, { action })).finally(() => setBusy(false))
  }
  const switchBack = () => run('switch back', async () => {
    if (notice.kind !== 'account_switched') return
    const client = threadClient(threadId)!
    const { target } = await client.call('threads.target.get', { thread_id: threadId })
    await client.call('threads.target.set', { thread_id: threadId, target: { ...target, provider: notice.from }, inherit_account: false })
    await loadTarget(threadId)
  })
  const stop = () => run('cancel the wait', async () => { await threadClient(threadId)!.call('threads.interrupt', { thread_id: threadId }) })
  return (
    <div testId={`account-notice-${notice.kind}`} paintTransform={tree.rise} style={{ position: 'relative', display: 'flex', alignItems: 'flex-start', gap: 8, paddingTop: 4, paddingBottom: 4, minWidth: 0 }}>
      <RowIcon box={20} size={16} source={icon} color={muted(t)} />
      <Para color={muted(t)} lineHeight={ROW_LINE} selectable style={{ flexShrink: 1, minWidth: 0 }}>{text}</Para>
      {(undo || waiting) && <div style={{ display: 'flex', alignItems: 'center', height: ROW_LINE, flexShrink: 0 }}>
        <RowAction testId={undo ? 'account-undo' : 'account-wait-cancel'} label={undo ? 'Undo' : 'Cancel'} aria={undo ? 'Undo the account switch' : 'Cancel the wait'} busy={busy} onClick={undo ? switchBack : stop} />
      </div>}
      {tree.lines}
    </div>
  )
}

/** The quiet pill beside a transcript line, like a fork notice's "Open". */
function RowAction({ testId, label, aria, busy, onClick }: { testId: string; label: string; aria: string; busy: boolean; onClick: () => void }) {
  const t = useTheme()
  return <div testId={testId} role="button" aria-label={aria} aria-disabled={busy || undefined} tabIndex={0} onClick={onClick} onKeyDown={(e) => { if (e.key === 'enter' || e.key === 'space') { keyboardAnswer(); onClick() } }}
    style={{ display: 'flex', alignItems: 'center', height: 20, paddingLeft: 8, paddingRight: 8, borderRadius: 10, backgroundColor: fg(t, 0.06), cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1, hover: { backgroundColor: fg(t, 0.1) } }}>
    <Label color={fg(t, 0.85)} size={12} lineHeight={16}>{label}</Label>
  </div>
}
