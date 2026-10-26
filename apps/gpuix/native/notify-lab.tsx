import '../src/native/local-build.ts'
import { render, useGpuixRequired } from '@gpuix/react'
import { useEffect, useState } from 'react'
import { attachNotificationHost, notifications } from '../src/native/notifications.ts'

// The notify check's window (WP5): the app's own notification module on the addon's renderer, driven by clicks.
// `status` shows the status the backend settled on, `posted` what each post returned, `clicks` the ids the
// module reported for notification clicks (the native side raised the window before each one).
const POSTS: Record<string, { id: string; title: string; body: string; group: string }> = {
  'post-t1-a': { id: 'agent:t1:1', title: 'Fix login', body: 'Needs approval: run <tests> & lint', group: 't1' },
  'post-t1-b': { id: 'agent:t1:2', title: 'Fix login', body: 'Finished working', group: 't1' },
  'post-t2': { id: 'agent:t2:1', title: 'Parser audit', body: 'Failed: boom', group: 't2' },
}

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
      onClick={() => { void notifications.post(POSTS[testId]!).then(result => setPosted(list => [...list, `${testId}=${result}`])) }}>
      <text style={{ color: '#ffffff', fontSize: 13 }}>{testId}</text>
    </div>
  )
  return (
    <div testId="ready" style={{ width: '100%', height: '100%', backgroundColor: '#18181b', padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <text testId="status" style={{ color: '#ffffff', fontSize: 13 }}>{status}</text>
      <text testId="reason" style={{ color: '#ffffff', fontSize: 13 }}>{reason || '-'}</text>
      <text testId="posted" style={{ color: '#ffffff', fontSize: 13 }}>{posted.join(' ') || '-'}</text>
      <text testId="clicks" style={{ color: '#ffffff', fontSize: 13 }}>{clicks.join(' ') || '-'}</text>
      {Object.keys(POSTS).map(button)}
    </div>
  )
}
render(<Lab />, { title: 'Notifications', width: 480, height: 360, focus: false })
