// Wheel latching lab for scroll-latch-check.ts: a transcript-like list (the transcript's own `cacheLayout`, so wheels take the
// native batching path) under the floating composer, which holds the shipped `ComposerTray` with enough background tasks to
// scroll, a short draft and the slash list's popup (`PopupLayer` with the completion list's scroller). Gestures are injected
// here with native phases (`simulateScrollPhase`; automation wheels have none), at the centre of the element a key names:
//   t transcript · y tray · f composer field · c completion list
// One gesture of 160 px down (contact, moves, lift, a short momentum tail); the digits 1 2 3 4 flick 4000 px over the same
// elements (key events report letters in lower case, so shift cannot tell them apart); `g` is 160 px up over the field.
// `o` opens the completion list; `d` swaps the short draft for one long enough to scroll inside the field. `state` reports `gestures:<n>` once a gesture's last packet is sent.
import '../src/native/local-build.ts'
import { render, useGpuix, type PublicInstance } from '@gpuix/react'
import { useRef, useState } from 'react'
import type { RuntimeTask } from '../../../packages/kybern-client/src/types.ts'
import { ThemeProvider, ink, useTheme } from '../src/ui.tsx'
import { ComposerTray } from '../src/requests/ComposerTray.tsx'
import { PopupLayer, popoverStyle } from '../src/composer/Menu.tsx'
import { TRANSCRIPT_SCROLL_LAYOUT } from '../src/transcript/scroll-layout.ts'

const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString()
const tasks: RuntimeTask[] = Array.from({ length: 16 }, (_, i) => ({
  id: `t${i}`, thread_id: 'lab', origin_turn_id: 'turn', started_seq: 1, updated_seq: 1, kind: 'process', status: 'running',
  title: `sleep ${600 + i}`, backgrounded: true, stats: {}, capabilities: { stop: true }, started_at: ago(30 + i), updated_at: ago(1),
}) as never)
const data = { threadId: 'lab', subagents: [], tasks, helpers: [], queued: [] }

type Phase = 'started' | 'moved' | 'ended' | 'cancelled'
type Renderer = { simulateScrollPhase: (x: number, y: number, dx: number, dy: number, phase: Phase) => void; getElementBounds: (id: number) => { x: number; y: number; width: number; height: number } | null }

function Lab() {
  const t = useTheme()
  const { renderer } = useGpuix()
  const r = renderer as unknown as Renderer
  const refs = { t: useRef<PublicInstance | null>(null), y: useRef<PublicInstance | null>(null), f: useRef<PublicInstance | null>(null), c: useRef<PublicInstance | null>(null) }
  const [completion, setCompletion] = useState(false)
  const [long, setLong] = useState(false)
  const [gestures, setGestures] = useState(0)
  const busy = useRef(false)
  const gesture = async (key: keyof typeof refs, distance: number) => {
    const node = refs[key].current
    const b = node && r.getElementBounds(node.id)
    if (!b || busy.current) return
    busy.current = true
    // The transcript's centre is under the composer: aim above it.
    const x = b.x + b.width / 2, y = key === 't' ? b.y + 120 : b.y + b.height / 2
    const send = async (dy: number, phase: Phase) => { r.simulateScrollPhase(x, y, 0, dy, phase); await Bun.sleep(8) }
    // Contact, moves that cover 60% of the distance, the lift, then a decaying momentum tail for the rest (GPUI reports
    // momentum as `moved` with no phase of its own).
    await send(0, 'started')
    const moves = 8, tail = 12
    for (let i = 0; i < moves; i++) await send(-(distance * 0.6) / moves, 'moved')
    await send(0, 'ended')
    const weights = Array.from({ length: tail }, (_, i) => tail - i), total = weights.reduce((a, b) => a + b, 0)
    for (const w of weights) await send(-(distance * 0.4) * w / total, 'moved')
    busy.current = false
    setGestures(n => n + 1)
  }
  const onKey = (k: string) => {
    if (k === 'o') { setCompletion(v => !v); return }
    if (k === 'd') { setLong(v => !v); return }
    const flick = ({ '1': 't', '2': 'y', '3': 'f', '4': 'c' } as Record<string, keyof typeof refs>)[k]
    if (flick) void gesture(flick, 4000)
    else if (k === 'g') void gesture('f', -160)
    else if (k in refs) void gesture(k as keyof typeof refs, 160)
  }
  return (
    <div testId="app-ready" tabIndex={0} onKeyDown={e => onKey(e.key ?? '')} style={{ position: 'relative', width: '100%', height: '100%', backgroundColor: t.surface }}>
      <virtual-list {...TRANSCRIPT_SCROLL_LAYOUT} ref={refs.t} testId="transcript" estimatedItemHeight={40} style={{ width: '100%', height: '100%' }}>
        {Array.from({ length: 240 }, (_, i) => (
          <div key={i} testId={`row-${i}`} style={{ display: 'flex', height: 40, alignItems: 'center', paddingLeft: 40 }}>
            <text style={{ color: ink(t, 0.7), fontSize: 13 }}>{`Transcript row ${i}`}</text>
          </div>
        ))}
      </virtual-list>
      {/* The thread page's floating composer: absolutely placed over the transcript, letting the wheel through. */}
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, display: 'flex', justifyContent: 'center', paddingBottom: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', width: 640 }}>
          <div testId="tray-frame" style={{ display: 'flex', flexDirection: 'column', width: '93.333%', alignSelf: 'center', marginBottom: -1, borderWidth: 1, borderBottomWidth: 0, borderColor: t.border, borderTopLeftRadius: 18.2, borderTopRightRadius: 18.2, backgroundColor: t.popover }}>
            <div ref={refs.y} style={{ display: 'flex', flexDirection: 'column' }}><ComposerTray data={data} /></div>
          </div>
          <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', height: 96, paddingTop: 14, paddingLeft: 16, paddingRight: 16, borderRadius: 19.2, borderWidth: 1, borderColor: t.border, backgroundColor: t.variant === 'dark' ? t.composer : '#ffffff' }}>
            {completion && (
              <PopupLayer kind="menu" side="top" align="start" sideOffset={8} collisionPadding={8} still testId="completion" style={{ ...popoverStyle(t), borderRadius: 12, display: 'flex', flexDirection: 'column', width: 360, overflow: 'hidden' }}>
                <div ref={refs.c} testId="completion-list" style={{ display: 'flex', flexDirection: 'column', padding: 6, overflowY: 'scroll', minHeight: 0, maxHeight: 280 }}>
                  {Array.from({ length: 30 }, (_, i) => (
                    <div key={i} testId={`command-${i}`} style={{ display: 'flex', height: 32, alignItems: 'center', paddingLeft: 10, flexShrink: 0 }}>
                      <text style={{ color: t.text, fontSize: 13 }}>{`/command-${i}`}</text>
                    </div>
                  ))}
                </div>
              </PopupLayer>
            )}
            <textarea ref={refs.f} testId="field" value={long ? Array.from({ length: 30 }, (_, i) => `Line ${i + 1} of a long draft`).join('\n') : 'A short draft'} onChange={() => {}} style={{ width: '100%', height: 40, fontSize: 14, color: t.text }} />
          </div>
        </div>
      </div>
      <text testId="state" style={{ position: 'absolute', left: 0, top: 0, width: 1, height: 1, opacity: 0 }}>{`gestures:${gestures}`}</text>
    </div>
  )
}

render(<ThemeProvider><Lab /></ThemeProvider>, { title: 'scroll-latch', width: 900, height: 860, focus: false })
