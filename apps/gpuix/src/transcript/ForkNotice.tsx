// The "Open" beside a fork notice in the source thread ("Forked to satyamas"): a pill that opens the new thread on the
// machine that holds it, like the sender chip of an inbound message.
import { keyboardAnswer } from '../requests/Panel.tsx'
import { openThread } from '../nav/history.ts'
import { Label, useTheme } from '../ui.tsx'
import { fg } from './kit.tsx'

export function ForkOpen({ machineId, threadId, machineName }: { machineId: string; threadId: string; machineName: string }) {
  const t = useTheme()
  const open = () => openThread(threadId, machineId)
  return <div testId="fork-open" role="button" aria-label={`Open the thread on ${machineName}`} tabIndex={0} onClick={open} onKeyDown={e => { if (e.key === 'enter' || e.key === 'space') { keyboardAnswer(); open() } }}
    style={{ display: 'flex', alignItems: 'center', height: 20, flexShrink: 0, paddingLeft: 8, paddingRight: 8, borderRadius: 10, backgroundColor: fg(t, 0.06), cursor: 'pointer', hover: { backgroundColor: fg(t, 0.1) } }}>
    <Label color={fg(t, 0.85)} size={12} lineHeight={16}>Open</Label>
  </div>
}
