// The strip that takes the composer's place on an archived thread: the conversation reads as it was, and Unarchive puts it
// back in its project's list. The composer returns by itself once the daemon reports the thread idle (`thread_updated`).
import { useState } from 'react'
import type { MachineId, Thread } from '../../../../packages/kybern-client/src/types.ts'
import { Button } from '../kit/Button.tsx'
import { Icon } from '../icons.tsx'
import { unarchiveThread } from '../nav/actions.ts'
import { N } from '../nav/glyphs.ts'
import { toastProblem } from '../problems/toast.ts'
import { requireThreadClient } from '../state.ts'
import { muted } from '../transcript/kit.tsx'
import { Label, useTheme } from '../ui.tsx'

export function ArchivedBar({ thread, machineId }: { thread: Thread; machineId?: MachineId }) {
  const t = useTheme()
  const [busy, setBusy] = useState(false)
  const unarchive = async () => {
    setBusy(true)
    try {
      await unarchiveThread(thread.id, requireThreadClient(thread.id, machineId))
    } catch (e) {
      toastProblem(e, { action: 'bring the thread back', projectId: thread.project_id })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div testId="archived-bar" style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', minHeight: 48, padding: 8, paddingLeft: 16, borderRadius: 19.2, borderWidth: 1, borderColor: t.border, backgroundColor: t.surface }}>
      <Icon source={N.archive} size={14} color={muted(t)} />
      <Label color={t.text} size={13} truncate>This thread is archived</Label>
      <div style={{ flexGrow: 1 }} />
      <Button size="sm" testId="archived-bar-unarchive" busy={busy} onClick={() => void unarchive()}>Unarchive</Button>
    </div>
  )
}
