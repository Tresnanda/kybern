import '../src/native/local-build.ts'
import { render, useGpuixRequired } from '@gpuix/react'
import { useEffect, useState } from 'react'
import { attachNotificationHost, currentNotificationIdentity, notifications, setEarlyAppIdentity } from '../src/native/notifications.ts'

// The notify check's window (WP5): the app's own notification module on the addon's renderer, driven by clicks.
// `status` shows the status the backend settled on, `posted` what each button returned, `clicks` the ids the
// module reported for notification clicks (the native side raised the window before each one), `identity` the id
// the module posts under (the app gives it to the addon before the window exists, as `main.tsx` does).
const POSTS: Record<string, { id: string; title: string; body: string; group: string }> = {
  'post-t1-a': { id: 'agent:t1:1', title: 'Fix login', body: 'Needs approval: run <tests> & lint', group: 't1' },
  'post-t1-b': { id: 'agent:t1:2', title: 'Fix login', body: 'Finished working', group: 't1' },
  'post-t2': { id: 'agent:t2:1', title: 'Parser audit', body: 'Failed: boom', group: 't2' },
}

/** Buttons that act on the module without posting: withdraw a thread's notification, or post twice back to back. */
const ACTIONS: Record<string, () => Promise<boolean>> = {
  'dismiss-t1': async () => { await notifications.dismiss('t1'); return true },
  'dismiss-t2': async () => { await notifications.dismiss('t2'); return true },
  // Two posts for one thread before the first has been answered: they must still be one notification.
  'post-t3-twice': async () => {
    const [first, second] = await Promise.all([notifications.post({ id: 'agent:t3:1', title: 'Docs', body: 'Needs approval: one', group: 't3' }), notifications.post({ id: 'agent:t3:2', title: 'Docs', body: 'Finished working', group: 't3' })])
    return first && second
  },
}
setEarlyAppIdentity()

function Lab() {
  const renderer = useGpuixRequired()
  const [status, setStatus] = useState('pending')
  const [reason, setReason] = useState('')
  const [posted, setPosted] = useState<string[]>([])
  const [clicks, setClicks] = useState<string[]>([])
  useEffect(() => {
    const backend = attachNotificationHost(renderer)
    const stop = notifications.onClick(id => setClicks(list => [...list, id]))
    void notifications.requestPermission().then(value => { setStatus(`${backend}:${value}`); setReason(notifications.reason ?? '') })
    return stop
  }, [renderer])
  const button = (testId: string) => (
    <div key={testId} testId={testId} style={{ width: 220, height: 28, backgroundColor: '#2a2a2e' }}
      onClick={() => { void (ACTIONS[testId] ? ACTIONS[testId]!() : notifications.post(POSTS[testId]!)).then(result => setPosted(list => [...list, `${testId}=${result}`])) }}>
      <text style={{ color: '#ffffff', fontSize: 13 }}>{testId}</text>
    </div>
  )
  return (
    <div testId="ready" style={{ width: '100%', height: '100%', backgroundColor: '#18181b', padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <text testId="identity" style={{ color: '#ffffff', fontSize: 13 }}>{currentNotificationIdentity().id}</text>
      <text testId="status" style={{ color: '#ffffff', fontSize: 13 }}>{status}</text>
      <text testId="reason" style={{ color: '#ffffff', fontSize: 13 }}>{reason || '-'}</text>
      <text testId="posted" style={{ color: '#ffffff', fontSize: 13 }}>{posted.join(' ') || '-'}</text>
      <text testId="clicks" style={{ color: '#ffffff', fontSize: 13 }}>{clicks.join(' ') || '-'}</text>
      {[...Object.keys(POSTS), ...Object.keys(ACTIONS)].map(button)}
    </div>
  )
}
render(<Lab />, { title: 'Notifications', width: 480, height: 420, focus: false })
