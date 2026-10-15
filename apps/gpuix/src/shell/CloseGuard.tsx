import { setWindowCloseHandler } from '@gpuix/native/host'
import { useGpuixRequired } from '@gpuix/react'
import { useEffect, useRef, useState } from 'react'
import type { Thread } from '../../../../packages/kybern-client/src/types.ts'
import { Dialog, DialogHeader } from '../nav/overlay.tsx'
import { errorText } from '../nav/actions.ts'
import { Button, Switch } from '../settings/controls.tsx'
import { getClient, getState } from '../state.ts'
import { Label, ProviderMark, useTheme } from '../ui.tsx'
import { load, save, flush } from './persist.ts'

export function CloseGuard() {
  const renderer = useGpuixRequired()
  const theme = useTheme()
  const [pending, setPending] = useState<Thread[] | null>(null)
  const [stopping, setStopping] = useState(false)
  const [askAgain, setAskAgain] = useState(true)
  const [error, setError] = useState('')
  const resolve = useRef<((allow: boolean) => void) | null>(null)
  useEffect(() => {
    if (!renderer.setCloseGuard || !renderer.resolveCloseRequest) return
    const off = setWindowCloseHandler(renderer, () => {
      const busy = getState().threads.filter((t) => t.status === 'running' || t.status === 'awaiting-approval')
      if (!load('kybern.askBeforeClose', true) || !busy.length) return true
      setPending(busy); setAskAgain(true); setError('')
      return new Promise<boolean>((done) => { resolve.current = done })
    })
    // Workspace remounts on environment changes; a pending native request must
    // never close a different environment's window.
    return () => { resolve.current?.(false); resolve.current = null; off() }
  }, [renderer])
  const finish = (allow: boolean) => {
    if (allow) { save('kybern.askBeforeClose', askAgain); flush() }
    const done = resolve.current
    resolve.current = null
    // An allowed decision removes the native window immediately; do not queue
    // a React commit against a renderer whose window has gone.
    if (!allow) setPending(null)
    done?.(allow)
  }
  if (!pending) return null
  const cancel = () => { if (!stopping) finish(false) }
  const stop = async () => {
    const client = getClient()
    if (!client) { setError('Reconnect to stop the threads, or close the window and keep them working.'); return }
    setStopping(true); setError('')
    const results = await Promise.allSettled(pending.map((thread) => client.call('threads.interrupt', { thread_id: thread.id })))
    if (getClient() !== client || !resolve.current) return
    const failed = results.find((result) => result.status === 'rejected')
    if (failed?.status === 'rejected') { setStopping(false); setError(`Unable to stop every thread. ${errorText(failed.reason)}`) }
    else finish(true)
  }
  const waiting = pending.filter((thread) => thread.status === 'awaiting-approval').length
  const title = waiting === pending.length
    ? `${pending.length} ${pending.length === 1 ? 'thread is' : 'threads are'} waiting for your approval`
    : `${pending.length} ${pending.length === 1 ? 'thread is' : 'threads are'} still working`
  return <Dialog testId="close-guard" width={480} onClose={cancel}>
    <DialogHeader title={title} description={`Agents keep working after the window closes. Open Kybern again to see what they did.${waiting ? ' Threads waiting for approval stay paused until you answer.' : ''}`} onClose={cancel} />
    <div style={{ display: 'flex', flexDirection: 'column', padding: 16, gap: 12 }}>
      {pending.slice(0, 4).map((thread) => <div key={thread.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}><ProviderMark kind={thread.provider.kind} size={16} /><Label color={theme.text} size={12} truncate style={{ flexGrow: 1 }}>{thread.title || 'Untitled'}</Label><Label color={theme.textSecondary} size={11}>{thread.status === 'awaiting-approval' ? 'Waiting for approval' : 'Working'}</Label></div>)}
      {pending.length > 4 && <Label color={theme.textSecondary} size={12}>{`and ${pending.length - 4} more`}</Label>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Switch testId="close-guard-remember" label="Ask again next time" checked={askAgain} onChange={setAskAgain} disabled={stopping} /><Label color={theme.textSecondary} size={12}>Ask again next time</Label></div>
      {error && <Label color={theme.red} size={12}>{error}</Label>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}><Button testId="close-guard-cancel" onClick={cancel} disabled={stopping}>Cancel</Button><Button testId="close-guard-stop" onClick={() => void stop()} disabled={stopping}>{stopping ? 'Stopping…' : 'Stop threads and close'}</Button><Button testId="close-guard-close" onClick={() => finish(true)} disabled={stopping}>Close window</Button></div>
    </div>
  </Dialog>
}
