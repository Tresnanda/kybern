// The strip that takes the composer's place on a thread that is moving to another machine or already moved (design
// §7.2): "Moving to satyamas…" while the lease is held, "This thread continues on satyamas · Open" afterwards. A move
// whose answer never came back offers "Keep here", which asks the other machine and gives the thread back.
import { useState } from 'react'
import { moveBanner } from '../../../../packages/kybern-client/src/continueOn.ts'
import { parseThreadLink } from '../../../../packages/kybern-client/src/forkMachine.ts'
import type { Thread } from '../../../../packages/kybern-client/src/types.ts'
import { Button } from '../kit/Button.tsx'
import { MatrixLoader } from '../MatrixLoader.tsx'
import { Icon } from '../icons.tsx'
import { openThread } from '../nav/history.ts'
import { errorText } from '../nav/actions.ts'
import { callThread } from '../state.ts'
import { toast } from '../shell/toasts.tsx'
import { T } from '../transcript/glyphs.ts'
import { muted } from '../transcript/kit.tsx'
import { Label, useTheme } from '../ui.tsx'

export function MoveBar({ thread, machineId }: { thread: Thread; machineId?: string }) {
  const t = useTheme()
  const banner = moveBanner(thread)
  const [busy, setBusy] = useState(false)
  if (!banner) return null
  const target = banner.open ? parseThreadLink(banner.open.href) : null
  const keep = async (force: boolean) => {
    setBusy(true)
    try {
      const result = await callThread(thread.id, 'threads.move_abandon', { thread_id: thread.id, force }, machineId)
      if (result.outcome === 'completed') toast.success(`${banner.machineName} already had the thread.`, { description: 'The move is done; this thread is read-only.' })
    } catch (e) {
      toast.error(errorText(e), force ? undefined : { description: 'Try again when the machine is online, or keep this thread anyway.', action: { label: 'Keep here anyway', onClick: () => void keep(true) } })
    } finally { setBusy(false) }
  }
  return <div testId="move-bar" style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, width: '100%', minHeight: 48, padding: 8, paddingLeft: 16, borderRadius: 19.2, borderWidth: 1, borderColor: t.border, backgroundColor: t.surface }}>
    {banner.state === 'departing' && !banner.uncertain
      ? <div style={{ display: 'flex', width: 14, height: 14, flexShrink: 0 }}><MatrixLoader /></div>
      : <Icon source={banner.uncertain ? T.alert : T.check} size={14} color={muted(t)} />}
    <Label color={t.text} size={13} truncate>{banner.text}</Label>
    <div style={{ flexGrow: 1 }} />
    {banner.uncertain && <Button variant="ghost" size="sm" testId="move-keep-here" busy={busy} onClick={() => void keep(false)}>Keep here</Button>}
    {target && <Button size="sm" testId="move-open" onClick={() => openThread(target.threadId, target.machineId)}>{banner.open!.label}</Button>}
  </div>
}
