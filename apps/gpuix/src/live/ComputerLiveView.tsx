import { useGpuix, type ImgInstance } from '@gpuix/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ComputerFrame, Settings } from '../../../../packages/kybern-client/src/types.ts'
import { getClient, useApp } from '../state.ts'
import { onWindowVisibility, isWindowVisible } from '../native/visibility.ts'
import { useDock } from '../dock/store.ts'
import { IconButton } from '../sidebar/rows.tsx'
import { N } from '../nav/glyphs.ts'
import { Label, useTheme } from '../ui.tsx'
import { Floating } from './Floating.tsx'
import { FramePoller } from './poll.ts'
export function ComputerLiveView() {
  const id = useApp(s => s.selectedId)
  const thread = useApp(s => s.open.thread)
  const connected = useApp(s => s.status === 'open')
  const [enabled, setEnabled] = useState(false)
  useEffect(() => {
    const client = getClient()
    if (!client || !connected) return
    let alive = true, revision = 0
    const off = client.onNotification('settings.changed', payload => { const s = (payload as { settings?: Settings }).settings; if (s) { revision++; setEnabled(s.computer_use?.enabled ?? false) } })
    void client.call('settings.get', {}).then(s => { if (alive && !revision) setEnabled(s.computer_use?.enabled ?? false) }).catch(() => {})
    return () => { alive = false; off() }
  }, [connected])
  return enabled && id && thread?.id === id ? <Live key={id} threadId={id} running={thread.status === 'running' || thread.status === 'awaiting-approval'} /> : null
}
function Live({ threadId, running }: { threadId: string; running: boolean }) {
  const t = useTheme()
  const dock = useDock(threadId)
  const { renderer } = useGpuix()
  const image = useRef<ImgInstance | null>(null)
  const [frame, setFrame] = useState<ComputerFrame | null>(null)
  const latestFrame = useRef(frame); latestFrame.current = frame
  const attachImage = useCallback((node: ImgInstance | null) => { image.current = node; if (node && latestFrame.current) renderer?.setImage?.(node.id, Buffer.from(latestFrame.current.data, 'base64')) }, [renderer])
  const [expanded, setExpanded] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  useEffect(() => { if (running) { setDismissed(false); setFrame(null) } }, [running])
  useEffect(() => {
    if (!running || dismissed) return
    const poll = new FramePoller(threadId, p => getClient()!.call('computer.frame', p), setFrame)
    const off = onWindowVisibility(visible => poll.show(visible))
    poll.show(isWindowVisible())
    return () => { poll.stop(); off() }
  }, [threadId, running, dismissed])
  useEffect(() => { if (running || !frame) return; const timer = setTimeout(() => setFrame(null), 12_000); return () => clearTimeout(timer) }, [running, !!frame])
  useEffect(() => { if (frame && image.current) renderer?.setImage?.(image.current.id, Buffer.from(frame.data, 'base64')) }, [frame, renderer])
  if (!frame || dismissed) return null
  const aspect = frame.width > 0 && frame.height > 0 ? frame.width / frame.height : 1.6
  const width = Math.max(208, Math.min(expanded ? 520 : 320, (expanded ? 480 : 360) * aspect))
  return <Floating storageKey="kybern.computerLiveView.corner" testId="computer-live" width={width} height={width / aspect + 46} insetEnd={dock.open ? Math.min(dock.width, 538) : 0}>
    <div style={{ position: 'relative', flexGrow: 1, minHeight: 0 }}><img ref={attachImage} testId="computer-live-image" alt={frame.title ? `${frame.app}: ${frame.title}` : frame.app} objectFit="contain" style={{ width: '100%', flexGrow: 1, minHeight: 0, backgroundColor: '#000000', height: '100%' }} />{frame.point && <div style={{ position: 'absolute', left: Math.max(0, Math.min(1, frame.point[0])) * width - 7, top: Math.max(0, Math.min(1, frame.point[1])) * width / aspect - 7, width: 14, height: 14, borderRadius: 7, borderWidth: 2, borderColor: '#ffffff', backgroundColor: 'rgba(40,110,245,0.6)', pointerEvents: 'none' }} />}</div>
    <div style={{ display: 'flex', alignItems: 'center', height: 36, gap: 6, paddingLeft: 10, paddingRight: 4 }}><Label color={t.text} size={11} truncate style={{ flexGrow: 1 }}>{`${frame.app} · ${frame.action ?? (running ? 'Working' : 'Done')}`}</Label><IconButton icon={N.window} size={28} label={expanded ? 'Show smaller' : 'Show larger'} onClick={() => setExpanded(!expanded)} /><IconButton icon={N.x} size={28} testId="computer-live-close" label="Hide until the next task" onClick={() => { setDismissed(true); setFrame(null) }} /></div>
  </Floating>
}
