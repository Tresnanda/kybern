import { setWindowCloseHandler } from '@gpuix/native/host'
import { useGpuixRequired } from '@gpuix/react'
import { useEffect, useRef, useState } from 'react'
import type { Thread } from '../../../../packages/kybern-client/src/types.ts'
import { Icon } from '../icons.tsx'
import { N } from '../nav/glyphs.ts'
import { Dialog } from '../nav/overlay.tsx'
import { errorText } from '../nav/actions.ts'
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
    // Screenshot fixture (visual/screens/shell.gpuix.ts): raise the guard over the first two seeded threads.
    if (process.env.KYBERN_PREVIEW_CLOSE_GUARD) {
      setTimeout(() => {
        const busy = getState().threads.filter((t) => ['Visual worktree', 'Dock visual review'].includes(t.title)).map((t) => ({ ...t, status: 'running' as const }))
        if (busy.length) setPending(busy)
      }, 1200)
    }
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
  return <Dialog testId="close-guard" width={448} onClose={cancel}>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 16, paddingRight: 16, paddingTop: 16, paddingBottom: 8 }}>
      <Label color={theme.text} size={18} weight={600} lineHeight={22}>{title}</Label>
      <Label color={theme.textSecondary} size={14} lineHeight={19}>{`Agents keep working after the window closes. Open Kybern again to see what they did.${waiting ? ' Threads waiting for approval stay paused until you answer.' : ''}`}</Label>
    </div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingLeft: 16, paddingRight: 16, paddingTop: 4, paddingBottom: 12 }}>
      {pending.slice(0, 4).map((thread) => <div key={thread.id} style={{ display: 'flex', alignItems: 'center', gap: 10, paddingLeft: 10, paddingRight: 10, paddingTop: 6, paddingBottom: 6 }}><ProviderMark kind={thread.provider.kind} size={16} /><Label color={theme.text} size={14} lineHeight={21} truncate style={{ flexGrow: 1 }}>{thread.title || 'Untitled'}</Label><Label color={theme.textSecondary} size={13}>{thread.status === 'awaiting-approval' ? 'Waiting for approval' : 'Working'}</Label></div>)}
      {pending.length > 4 && <div style={{ paddingLeft: 10, paddingTop: 4, paddingBottom: 4 }}><Label color={theme.textSecondary} size={12}>{`and ${pending.length - 4} more`}</Label></div>}
    </div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 16, paddingRight: 16, paddingBottom: 4 }}>
      <div testId="close-guard-remember" role="checkbox" aria-label="Ask again next time" aria-checked={askAgain} tabIndex={stopping ? -1 : 0} onClick={() => { if (!stopping) setAskAgain(!askAgain) }} onKeyDown={(e) => { if (!stopping && (e.key === 'space' || e.key === 'enter')) setAskAgain(!askAgain) }} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 16, height: 16, flexShrink: 0, borderRadius: 4, borderWidth: 1, borderColor: askAgain ? theme.text : theme.border, backgroundColor: askAgain ? theme.text : 'transparent', opacity: stopping ? 0.45 : 1 }}>{askAgain && <Icon source={N.check} size={12} color={theme.surface} />}</div>
      <Label color={theme.textSecondary} size={14} lineHeight={20}>Ask again next time</Label>
    </div>
    {error && <div style={{ paddingLeft: 16, paddingRight: 16, paddingTop: 8 }}><Label color={theme.red} size={12}>{error}</Label></div>}
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingLeft: 16, paddingRight: 16, paddingTop: 12, paddingBottom: 12 }}>
      <GuardButton testId="close-guard-cancel" tone="outline" disabled={stopping} onClick={cancel}>Cancel</GuardButton>
      <GuardButton testId="close-guard-stop" tone="destructive" disabled={stopping} onClick={() => void stop()}>{stopping ? 'Stopping…' : 'Stop threads and close'}</GuardButton>
      <GuardButton testId="close-guard-close" tone="primary" disabled={stopping} onClick={() => finish(true)}>Close window</GuardButton>
    </div>
  </Dialog>
}

/** The kit's footer buttons: `chrome-outline`, `destructive-outline` and the default (primary) variants, 32px tall. */
function GuardButton({ children, tone, onClick, disabled, testId }: { children: string; tone: 'outline' | 'destructive' | 'primary'; onClick: () => void; disabled: boolean; testId: string }) {
  const t = useTheme()
  return (
    <div testId={testId} role="button" aria-label={children} tabIndex={disabled ? -1 : 0} onClick={() => !disabled && onClick()} onKeyDown={(e) => { if (!disabled && (e.key === 'enter' || e.key === 'space')) onClick() }} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 32, paddingLeft: 12, paddingRight: 12, borderRadius: 10, borderWidth: tone === 'primary' ? 0 : 1, borderColor: tone === 'destructive' ? t.border : t.border, backgroundColor: tone === 'primary' ? t.buttonPrimary : 'transparent', opacity: disabled ? 0.45 : 1, cursor: disabled ? 'default' : 'pointer', hover: { backgroundColor: tone === 'primary' ? t.buttonPrimary : t.buttonSecondaryHover } }}>
      <Label color={tone === 'primary' ? t.buttonPrimaryText : tone === 'destructive' ? t.red : t.text} size={14} lineHeight={20}>{children}</Label>
    </div>
  )
}
