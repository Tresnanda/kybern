import { BACKDROP } from '../native/backdrop.ts'
import { BACKDROP_ALLOWED } from '../native/backdrop-material.ts'
import { motion, useGpuix, type ImgInstance } from '@gpuix/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ComputerFrame, Settings } from '../../../../packages/kybern-client/src/types.ts'
import { getClient, useApp } from '../state.ts'
import { onWindowVisibility, isWindowVisible } from '../native/visibility.ts'
import { useDock } from '../dock/store.ts'
import { IconButton } from '../sidebar/rows.tsx'
import { N } from '../nav/glyphs.ts'
import { EASE_OUT, Label, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { Floating } from './Floating.tsx'
import { actionParts } from './action.ts'
import { Shimmer } from '../transcript/motion.tsx'
import { Icon } from '../icons.tsx'
import { FramePoller } from './poll.ts'
/** kybern.css `.computer-live-view`: black backing, a 1px white-10% ring and the two-layer shadow. */
const LIVE_CARD = { backgroundColor: '#000000', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)', boxShadow: { offsetX: 0, offsetY: 16, blurRadius: 56, spreadRadius: -16, color: 'rgba(0,0,0,0.5)' } } as const
export function ComputerLiveView({ insetBottom = 0 }: { insetBottom?: number } = {}) {
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
  return enabled && id && thread?.id === id ? <Live key={id} insetBottom={insetBottom} threadId={id} running={thread.status === 'running' || thread.status === 'awaiting-approval'} /> : null
}
function Live({ threadId, running, insetBottom }: { threadId: string; running: boolean; insetBottom: number }) {
  const t = useTheme()
  const dock = useDock(threadId)
  const [frame, setFrame] = useState<ComputerFrame | null>(null)
  const [imageRevision, setImageRevision] = useState(0)
  const [previous, setPrevious] = useState<ComputerFrame | null>(null)
  const latestFrame = useRef(frame); latestFrame.current = frame
  const acceptFrame = useCallback((next: ComputerFrame) => {
    const previous = latestFrame.current
    if (next.seq === previous?.seq) return
    const changedImage = next.data !== previous?.data || next.media_type !== previous?.media_type
    // Capture sequence/time alone do not change the pixels or footer. Keep the
    // current native image and avoid a whole-window layout for identical frames.
    if (!changedImage && next.app === previous?.app && next.title === previous?.title && next.action === previous?.action && next.width === previous?.width && next.height === previous?.height && next.point?.[0] === previous?.point?.[0] && next.point?.[1] === previous?.point?.[1]) return
    if (changedImage) { setPrevious(REDUCED_MOTION ? null : latestFrame.current); setImageRevision(value => value + 1) }
    setFrame(next)
  }, [])
  useEffect(() => { if (!previous) return; const timer = setTimeout(() => setPrevious(null), 200); return () => clearTimeout(timer) }, [imageRevision, previous])
  const [expanded, setExpanded] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  useEffect(() => { if (running) { setDismissed(false); setFrame(null); setPrevious(null) } }, [running])
  useEffect(() => {
    if (!running || dismissed) return
    const poll = new FramePoller(threadId, p => getClient()!.call('computer.frame', p), acceptFrame)
    const off = onWindowVisibility(visible => poll.show(visible))
    poll.show(isWindowVisible())
    return () => { poll.stop(); off() }
  }, [threadId, running, dismissed])
  useEffect(() => { if (running || !frame) return; const timer = setTimeout(() => setFrame(null), 12_000); return () => clearTimeout(timer) }, [running, !!frame])
  if (!frame || dismissed) return null
  const aspect = frame.width > 0 && frame.height > 0 ? frame.width / frame.height : 1.6
  const width = Math.max(208, Math.min(expanded ? 520 : 320, (expanded ? 480 : 360) * aspect))
  return <Floating insetBottom={insetBottom} storageKey="kybern.computerLiveView.corner" testId="computer-live" width={width} height={width / aspect} overlayDrag cardStyle={LIVE_CARD} insetEnd={dock.open ? Math.min(dock.width, 538) : 0}>
    <div onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} style={{ position: 'relative', flexGrow: 1, minHeight: 0 }}>{previous && <motion.div key={imageRevision - 1} initial={false} animate={{ opacity: 1 }} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, pointerEvents: 'none' }}><FrameImage frame={previous} /></motion.div>}
      <motion.div key={imageRevision} initial={previous && !REDUCED_MOTION ? { opacity: 0 } : false} animate={{ opacity: 1 }} transition={{ duration: 0.18, ease: EASE_OUT }} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, pointerEvents: 'none' }}><FrameImage frame={frame} current /></motion.div>{frame.point && <div style={{ position: 'absolute', left: Math.max(0, Math.min(1, frame.point[0])) * width - 7, top: Math.max(0, Math.min(1, frame.point[1])) * width / aspect - 7, width: 14, height: 14, borderRadius: 7, borderWidth: 2, borderColor: '#ffffff', backgroundColor: 'rgba(40,110,245,0.6)', pointerEvents: 'none' }} />}
      <Scrim height={width >= 260 ? 76 : 56} />
      <div style={{ position: 'absolute', left: 12, right: 12, bottom: 10, display: 'flex', flexDirection: 'column', gap: 1, pointerEvents: 'none' }}>{width >= 260 && <Label color="rgba(255,255,255,0.72)" size={11} lineHeight={14} weight={500} truncate>{frame.app}</Label>}<Caption action={frame.action ?? (running ? 'Working' : 'Done')} live={running} /></div>
      <div backdrop={hovered && BACKDROP_ALLOWED ? {...BACKDROP.liveControls,radius:8} : undefined} style={{ position: 'absolute', top: 8, right: 8, display: 'flex', gap: 4, opacity: hovered ? 1 : 0, pointerEvents: hovered ? 'auto' : 'none', backgroundColor: BACKDROP_ALLOWED ? 'rgba(0,0,0,.45)' : t.popover, borderRadius: 8 }}><IconButton icon={N.window} size={28} label={expanded ? 'Show smaller' : 'Show larger'} onClick={() => setExpanded(!expanded)} /><IconButton icon={N.x} size={28} testId="computer-live-close" label="Hide until the next task" onClick={() => { setDismissed(true); setFrame(null); setPrevious(null) }} /></div>
    </div>
  </Floating>
}

// The keyed motion wrappers keep the old current image alive as the previous
// image during the crossfade: no second upload/decode of identical old bytes.
// Two native image nodes only during a crossfade; bytes are released with the old frame.
function FrameImage({ frame, current = false }: { frame: ComputerFrame; current?: boolean }) {
  const { renderer } = useGpuix()
  const attach = useCallback((node: ImgInstance | null) => { if (node) renderer?.setImage?.(node.id, Buffer.from(frame.data, 'base64')) }, [renderer, frame.data, frame.media_type])
  return <img ref={attach} testId={current ? 'computer-live-image' : undefined} alt={frame.title ? `${frame.app}: ${frame.title}` : frame.app} objectFit="contain" style={{ width: '100%', height: '100%', borderRadius: 16, backgroundColor: '#000000', pointerEvents: 'none' }} />
}

/** `linear-gradient(to top, .66, .4 50%, transparent)` under `mask-image: linear-gradient(to top, black 50%, transparent)`, as four contiguous two-stop bands (top to bottom: 0, .1, .4, .53, .66). */
function Scrim({ height }: { height: number }) {
  const stops = [0, 0.1, 0.4, 0.53, 0.66], band = height / 4
  return <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height, display: 'flex', flexDirection: 'column', borderBottomLeftRadius: 16, borderBottomRightRadius: 16, overflow: 'hidden', pointerEvents: 'none' }}>
    {[0, 1, 2, 3].map(i => <div key={i} style={{ height: band, flexShrink: 0, background: { type: 'linear-gradient', angle: 180, stops: [{ color: `rgba(0,0,0,${stops[i]})`, position: 0 }, { color: `rgba(0,0,0,${stops[i + 1]})`, position: 1 }] } }} />)}
  </div>
}
/** While the agent works, the leading verb shimmers; a finished step carries a check (desktop `ActionText`). */
function Caption({ action, live }: { action: string; live: boolean }) {
  const parts = actionParts(action), lead = Math.max(0, parts.findIndex(part => !part.subject))
  return <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0, height: 16 }}>
    {!live && <Icon source={N.check} size={12} color="#ffffff" />}
    {parts.map((part, index) => part.keys
      ? <div key={index} style={{ paddingLeft: 4, paddingRight: 4, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.16)' }}><Label color="#ffffff" size={12} lineHeight={16} weight={500}>{part.text}</Label></div>
      : live && index === lead && !part.subject ? <Shimmer key={index} text={part.text} color="rgba(255,255,255,0.62)" size={12} lineHeight={16} />
      : <Label key={index} color={part.subject ? '#ffffff' : 'rgba(255,255,255,0.62)'} size={12} lineHeight={16} weight={part.subject ? 500 : undefined} truncate>{part.text}</Label>)}
  </div>
}
