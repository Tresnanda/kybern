import { BACKDROP } from '../native/backdrop.ts'
import { BACKDROP_ALLOWED } from '../native/backdrop-material.ts'
import { motion, useGpuix, type ImgInstance } from '@gpuix/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ComputerFrame, Settings } from '../../../../packages/kybern-client/src/types.ts'
import { getClient, useApp } from '../state.ts'
import { onWindowVisibility, isWindowVisible } from '../native/visibility.ts'
import { useDock } from '../dock/store.ts'
import { IconButton } from '../kit/IconButton.tsx'
import { N } from '../nav/glyphs.ts'
import { EASE_OUT, Label, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { EASE } from '../motion/kit.tsx'
import { PATCHED_NATIVE } from '../native/local-build.ts'
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
  // The daemon turned pictures off (e.g. screenshot consent declined on Wayland). Polling goes on at its normal rate: it is what marks the chat watched.
  const [paused, setPaused] = useState<string | null>(null)
  const [veilSeen, setVeilSeen] = useState(false)
  const lastReason = useRef('')
  if (paused) lastReason.current = paused
  const acceptPaused = useCallback((reason: string | null) => { setPaused(reason); if (reason) setVeilSeen(true) }, [])
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
  // The revealed controls take the pointer from the card, so the card's enter/leave alone flaps at 60 Hz while the pointer rests on them.
  const [overBody, setOverBody] = useState(false), [overControls, setOverControls] = useState(false)
  const hovered = overBody || overControls
  const [dismissed, setDismissed] = useState(false)
  // Hiding (the ✕ or the 12 s after a task ends) fades the card out first; `closing` carries which one it is.
  const [closing, setClosing] = useState<'dismiss' | 'idle' | null>(null)
  useEffect(() => { if (running) { setDismissed(false); setClosing(null); setFrame(null); setPrevious(null); setPaused(null); setVeilSeen(false) } }, [running])
  const left = () => { if (closing === 'dismiss') setDismissed(true); setClosing(null); setFrame(null); setPrevious(null); setPaused(null); setVeilSeen(false) }
  // `.computer-live-marker`: a ring ripples out from where the agent clicked (480 ms, at most three alive, none under Reduce Motion).
  const [ripples, setRipples] = useState<{ id: number; x: number; y: number }[]>([])
  const lastClick = useRef('')
  useEffect(() => {
    const point = frame?.point
    if (!frame || !point || paused || !PATCHED_NATIVE || REDUCED_MOTION) return
    const key = `${point[0]},${point[1]},${frame.action ?? ''}`
    if (key === lastClick.current) return
    lastClick.current = key
    setRipples(list => [...list.slice(-2), { id: frame.seq, x: Math.max(0, Math.min(1, point[0])), y: Math.max(0, Math.min(1, point[1])) }])
  }, [frame?.seq])
  useEffect(() => {
    if (!running || dismissed || closing) return
    const poll = new FramePoller(threadId, p => getClient()!.call('computer.frame', p), acceptFrame)
    poll.onPaused = acceptPaused
    const off = onWindowVisibility(visible => poll.show(visible))
    poll.show(isWindowVisible())
    return () => { poll.stop(); off() }
  }, [threadId, running, dismissed, !!closing])
  useEffect(() => { if (running || (!frame && !paused)) return; const timer = setTimeout(() => setClosing(current => current ?? 'idle'), 12_000); return () => clearTimeout(timer) }, [running, !!frame, !!paused])
  if ((!frame && !paused) || dismissed) return null
  const aspect = frame && frame.width > 0 && frame.height > 0 ? frame.width / frame.height : 1.6
  const width = Math.max(208, Math.min(expanded ? 520 : 320, (expanded ? 480 : 360) * aspect))
  return <Floating insetBottom={insetBottom} storageKey="kybern.computerLiveView.corner" testId="computer-live" width={width} height={width / aspect} overlayDrag leaving={!!closing} onLeft={left} cardStyle={LIVE_CARD} insetEnd={dock.open ? Math.min(dock.width, 538) : 0}>
    <div onMouseEnter={() => setOverBody(true)} onMouseLeave={() => setOverBody(false)} style={{ position: 'relative', flexGrow: 1, minHeight: 0 }}>{previous && <motion.div key={imageRevision - 1} initial={false} animate={{ opacity: 1 }} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, pointerEvents: 'none' }}><FrameImage frame={previous} /></motion.div>}
      {frame && <motion.div key={imageRevision} initial={previous && !REDUCED_MOTION ? { opacity: 0 } : false} animate={{ opacity: 1 }} transition={{ duration: 0.18, ease: EASE_OUT }} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, pointerEvents: 'none' }}><FrameImage frame={frame} current /></motion.div>}{frame?.point && !paused && <div style={{ position: 'absolute', left: Math.max(0, Math.min(1, frame.point[0])) * width - 7, top: Math.max(0, Math.min(1, frame.point[1])) * width / aspect - 7, width: 14, height: 14, borderRadius: 7, borderWidth: 2, borderColor: '#ffffff', backgroundColor: 'rgba(40,110,245,0.6)', pointerEvents: 'none' }} />}
      <Scrim height={width >= 260 ? 76 : 56} />
      <div style={{ position: 'absolute', left: 12, right: 12, bottom: 10, display: 'flex', flexDirection: 'column', gap: 1, pointerEvents: 'none' }}>{frame && width >= 260 && <Label color="rgba(255,255,255,0.72)" size={11} lineHeight={14} weight={500} truncate>{frame.app}</Label>}{frame && <Caption action={frame.action ?? (running ? 'Working' : 'Done')} live={running} />}</div>
      {veilSeen && <PausedVeil shown={!!paused} reason={paused ?? lastReason.current} dimmed={!!frame} />}
      {ripples.map(ripple => <Ripple key={ripple.id} x={ripple.x * width} y={ripple.y * width / aspect} onDone={() => setRipples(list => list.filter(item => item.id !== ripple.id))} />)}
      <LiveControls hovered={hovered} expanded={expanded} onEnter={() => setOverControls(true)} onLeave={() => setOverControls(false)} onToggle={() => setExpanded(!expanded)} onClose={() => setClosing('dismiss')} />
    </div>
  </Floating>
}

/** "Live view paused": the last frame dims, the reason sits under the title in secondary text. It fades in and out (opacity only, instant under Reduce Motion); the card never gets a modal or a prompt. */
export function PausedVeil({ shown, reason, dimmed }: { shown: boolean; reason: string; dimmed: boolean }) {
  return <motion.div initial={false} animate={{ opacity: shown ? 1 : 0 }} transition={REDUCED_MOTION ? { duration: 0 } : { duration: shown ? 0.24 : 0.16, ease: EASE_OUT }} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4, paddingLeft: 20, paddingRight: 20, borderRadius: 16, backgroundColor: dimmed ? 'rgba(0,0,0,0.62)' : 'rgba(0,0,0,0)', pointerEvents: 'none' }}>
    <div role="status" aria-label={`Live view paused. ${reason}`} testId="computer-live-paused" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, minWidth: 0, maxWidth: '100%' }}>
      <Label color="rgba(255,255,255,0.92)" size={13} lineHeight={17} weight={500}>Live view paused</Label>
      <Label color="rgba(255,255,255,0.62)" size={12} lineHeight={16} style={{ textAlign: 'center' }}>{reason}</Label>
    </div>
  </motion.div>
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

/** `.computer-live-controls`: the buttons rise 4 px into place over 200 ms on hover and settle back in 120 ms (opacity only under Reduce Motion). */
export function controlsTransform(shown: boolean) {
  if (!PATCHED_NATIVE) return undefined
  return { initial: false as const, animate: { opacity: shown ? 1 : 0, translateY: shown || REDUCED_MOTION ? 0 : 4 }, transition: { duration: shown ? 0.2 : 0.12, ease: [...EASE.out] as [number, number, number, number] } }
}
/** `.computer-live-marker`: a 24 px ring that grows from 40% to 160% while fading from 50% over 480 ms, then removes itself. */
export function Ripple({ x, y, onDone }: { x: number; y: number; onDone: () => void }) {
  return <div
    paintTransform={{ initial: { scale: 0.4, opacity: 0.5 }, animate: { scale: 1.6, opacity: 0 }, transition: { duration: 0.48, ease: [...EASE.out] } }}
    onMotionComplete={onDone}
    style={{ position: 'absolute', left: x - 12, top: y - 12, width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: '#ffffff', pointerEvents: 'none' }}
  />
}

/** The hover buttons in the card's top-right corner: they rise into place when the pointer is over the card or themselves. */
export function LiveControls({ hovered, expanded, onEnter, onLeave, onToggle, onClose }: { hovered: boolean; expanded: boolean; onEnter: () => void; onLeave: () => void; onToggle: () => void; onClose: () => void }) {
  const t = useTheme()
  return <div onMouseEnter={onEnter} onMouseLeave={onLeave} paintTransform={controlsTransform(hovered)} backdrop={hovered && BACKDROP_ALLOWED ? {...BACKDROP.liveControls,radius:8} : undefined} style={{ position: 'absolute', top: 8, right: 8, display: 'flex', gap: 4, ...(PATCHED_NATIVE ? {} : { opacity: hovered ? 1 : 0 }), pointerEvents: hovered ? 'auto' : 'none', backgroundColor: BACKDROP_ALLOWED ? 'rgba(0,0,0,.45)' : t.popover, borderRadius: 8 }}><IconButton icon={N.window} color="rgba(255,255,255,0.88)" style={{ hover: { backgroundColor: 'rgba(255,255,255,0.16)' }, active: { backgroundColor: 'rgba(255,255,255,0.1)' } }} label={expanded ? 'Show smaller' : 'Show larger'} onClick={onToggle} /><IconButton icon={N.x} color="rgba(255,255,255,0.88)" style={{ hover: { backgroundColor: 'rgba(255,255,255,0.16)' }, active: { backgroundColor: 'rgba(255,255,255,0.1)' } }} testId="computer-live-close" label="Hide until the next task" onClick={onClose} /></div>
}
