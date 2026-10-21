// P2 motion lab: the real composer / transcript / request / subagent / live-view pieces in fixed spots, driven by keys and real
// mouse events from motion-p2-strips.ts. Every widget is the shipped component; only its inputs are scripted.
// e sending · u running · z/x add/remove attachment · y/q add/remove queued row · w clear queue · d busy dim · b scroll button
// i new fresh image · p request panel · o same, as a keyboard answer · l button label · k disclosure · a subagent phase
// f live card leaving · r ripple · h live controls · m hover user footer
import '../src/native/local-build.ts'
import { render } from '@gpuix/react'
import { Profiler, useState } from 'react'
import { ThemeProvider, useTheme, Label, ink } from '../src/ui.tsx'
import { Collapse } from '../src/motion/kit.tsx'
import { Attachments, SendButton } from '../src/Composer.tsx'
import { ComposerTray } from '../src/requests/ComposerTray.tsx'
import { TrayChip } from '../src/composer/chips.tsx'
import { Dim } from '../src/composer/motion.tsx'
import { EffortSlider } from '../src/composer/ModelPicker.tsx'
import { BottomFade, ScrollToBottom } from '../src/Transcript.tsx'
import { ResponseImage } from '../src/transcript/images.tsx'
import { Button, Chevron } from '../src/transcript/kit.tsx'
import { PanelEnter, PanelPresence, keyboardAnswer } from '../src/requests/Panel.tsx'
import { SubagentBar } from '../src/subagents/Page.tsx'
import { Floating } from '../src/live/Floating.tsx'
import { LiveControls, Ripple } from '../src/live/ComputerLiveView.tsx'
import { G } from '../src/composer/glyphs.ts'

let commits = 0
const IMAGE = new URL('../../desktop/public/release-background.png', import.meta.url).pathname
const at = (x: number, y: number, w: number, h: number) => ({ position: 'absolute', left: x, top: y, width: w, height: h, display: 'flex' }) as const
const attachment = (n: number) => ({ id: `a${n}`, name: `shot-${n}.png`, media_type: 'image/png', size: 1024, label: `image${n}`, path: IMAGE })
const queued = (n: number) => ({ id: `q${n}`, message: { parts: [{ type: 'text' as const, text: `Follow-up number ${n}: check the failing migration` }] } })
const thread = (phase: 'pending' | 'running' | 'completed') => ({
  id: 'lab-sub', title: 'Review', provider: { kind: 'claude-code', instance: 'default' }, model: 'opus', effort: null, status: 'idle', parent_thread_id: 'lab-parent',
  subagent: { task_id: 't', root_thread_id: 'r', parent_turn_id: 'p', agent_type: 'general-purpose', status: phase, started_at: new Date(Date.now() - 4000).toISOString(), completed_at: phase === 'completed' ? new Date().toISOString() : null, capabilities: { stop: true, background: true } },
}) as never

function Lab() {
  const t = useTheme()
  const [sending, setSending] = useState(false), [running, setRunning] = useState(false)
  const [attachments, setAttachments] = useState([attachment(1), attachment(2)]), [attachN, setAttachN] = useState(3)
  const [queue, setQueue] = useState([queued(1), queued(2)]), [queueN, setQueueN] = useState(3)
  const [busy, setBusy] = useState(false), [scroll, setScroll] = useState(false), [imageN, setImageN] = useState(0)
  const [panel, setPanel] = useState(true), [label, setLabel] = useState(false), [open, setOpen] = useState(false), [phase, setPhase] = useState<'pending' | 'running' | 'completed'>('running')
  const [leaving, setLeaving] = useState(false), [ripples, setRipples] = useState<number[]>([]), [controls, setControls] = useState(false), [effort, setEffort] = useState('medium')
  const key = (k: string) => {
    if (k === 'e') setSending(v => !v)
    if (k === 'u') setRunning(v => !v)
    if (k === 'z') { setAttachments(list => [...list, attachment(attachN)]); setAttachN(n => n + 1) }
    if (k === 'x') setAttachments(list => list.slice(1))
    if (k === 'y') { setQueue(list => [...list, queued(queueN)]); setQueueN(n => n + 1) }
    if (k === 'q') setQueue(list => list.slice(1))
    if (k === 'w') setQueue([])
    if (k === 'd') setBusy(v => !v)
    if (k === 'b') setScroll(v => !v)
    if (k === 'i') setImageN(n => n + 1)
    if (k === 'p') setPanel(v => !v)
    if (k === 'o') { keyboardAnswer(); setPanel(v => !v) }
    if (k === 'l') setLabel(v => !v)
    if (k === 'k') setOpen(v => !v)
    if (k === 'a') setPhase(v => (v === 'running' ? 'completed' : 'running'))
    if (k === 'f') setLeaving(v => !v)
    if (k === 'r') setRipples(list => [...list.slice(-2), Date.now()])
    if (k === 'h') setControls(v => !v)
  }
  const card = ink(t, 0.06)
  return (
    <div testId="app-ready" onKeyDown={e => key(e.key ?? '')} style={{ position: 'relative', width: '100%', height: '100%', backgroundColor: t.surface }}>
      <div testId="send-slot" style={at(16, 16, 60, 44)}><SendButton running={running} sending={sending} canSend steering={false} onSubmit={() => {}} onStop={() => {}} /></div>
      <div testId="attachments" style={{ ...at(100, 24, 440, 84), flexDirection: 'column' }}><Attachments items={attachments} uploading={0} onRemove={a => setAttachments(list => list.filter(item => item.id !== a.id))} /></div>
      <div testId="queued" style={{ ...at(560, 16, 560, 140), flexDirection: 'column', justifyContent: 'flex-end', alignItems: 'center' }}>{queue.length > 0 && <div style={{ display: 'flex', flexDirection: 'column', width: '93.33%', borderWidth: 1, borderBottomWidth: 0, borderColor: t.border, borderTopLeftRadius: 18.2, borderTopRightRadius: 18.2, backgroundColor: t.popover }}><ComposerTray data={{ threadId: 'lab', subagents: [], tasks: [], helpers: [], queued: queue as never }} /></div>}</div>
      <div testId="tray" style={at(16, 140, 200, 36)}><TrayChip testId="tray-chip" icon={G.clock} label="main" /></div>
      <div testId="slider" style={{ ...at(240, 130, 300, 70), flexDirection: 'column', borderRadius: 12, backgroundColor: card }}>
        <EffortSlider efforts={['low', 'medium', 'high', 'xhigh', 'max']} value={effort} disabled={false} onEscape={() => {}} onChange={async next => { setEffort(next); return true }} />
      </div>
      <div testId="dim" style={{ ...at(560, 170, 260, 56), flexDirection: 'column', borderRadius: 12, backgroundColor: card }}><Dim dimmed={busy} style={{ padding: 12, gap: 4 }}><Label color={t.text} size={13}>Model options</Label><Label color={t.textSecondary} size={12}>Reasoning · Fast mode</Label></Dim></div>
      <div testId="scroll" style={{ ...at(16, 230, 300, 170), flexDirection: 'column', gap: 8, padding: 12, overflow: 'hidden', borderRadius: 12, borderWidth: 1, borderColor: t.border }}>
        {[0, 1, 2, 3, 4].map(i => <div key={i} style={{ height: 10, width: 200 - i * 20, borderRadius: 5, backgroundColor: ink(t, 0.18) }} />)}
        <BottomFade visible={scroll} fallback={0} />
        <ScrollToBottom visible={scroll} bottom={36} onClick={() => setScroll(false)} />
      </div>
      <div testId="image" style={{ ...at(340, 230, 320, 180), alignItems: 'flex-start' }}>{imageN > 0 && <ResponseImage key={imageN} source={IMAGE} at={new Date().toISOString()} />}</div>
      <div testId="panel" style={{ ...at(690, 240, 430, 160), flexDirection: 'column', justifyContent: 'flex-end' }}>
        <PanelPresence show={panel}>
          <div style={{ display: 'flex', flexDirection: 'column', width: '100%', gap: 6 }}>
            <PanelEnter key={String(panel)}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 14, borderRadius: 14, borderWidth: 1, borderColor: t.border, backgroundColor: t.popover }}>
                <Label color={t.text} weight={500}>Run npm test?</Label><Label color={t.textSecondary} size={12}>The agent wants to run a command in your project.</Label>
              </div>
            </PanelEnter>
          </div>
        </PanelPresence>
      </div>
      <div testId="button" style={at(16, 430, 160, 32)}><Button swap variant="default">{label ? 'Sending…' : 'Send answer'}</Button></div>
      <div testId="disclosure" style={{ ...at(200, 430, 320, 120), flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, height: 24 }}><Label color={t.textSecondary}>Worked for 12s</Label><Chevron open={open} color={t.textSecondary} /></div>
        <Collapse open={open}><div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 6 }}>{[0, 1, 2].map(i => <Label key={i} color={t.textSecondary} size={12}>{`Ran command ${i + 1}`}</Label>)}</div></Collapse>
      </div>
      <div testId="subagent" style={{ ...at(16, 570, 700, 56), flexDirection: 'column' }}><SubagentBar thread={thread(phase)} embedded /></div>
      <div testId="live" style={{ ...at(700, 430, 440, 300), borderRadius: 12, backgroundColor: ink(t, 0.04) }}>
        <Floating storageKey="kybern.lab.corner" width={300} height={180} testId="lab-live" overlayDrag leaving={leaving} onLeft={() => {}} cardStyle={{ backgroundColor: '#000000' }}>
          <div style={{ position: 'relative', flexGrow: 1, backgroundColor: '#1d3557', alignItems: 'center', justifyContent: 'center', display: 'flex' }}>
            <Label color="#ffffff">Live frame</Label>
            {ripples.map(id => <Ripple key={id} x={150} y={100} onDone={() => setRipples(list => list.filter(item => item !== id))} />)}
            <LiveControls hovered={controls} expanded={false} onEnter={() => setControls(true)} onLeave={() => setControls(false)} onToggle={() => {}} onClose={() => setLeaving(true)} />
          </div>
        </Floating>
      </div>
    </div>
  )
}
render(<ThemeProvider><Profiler id="lab" onRender={() => { console.error(`[lab-commit] ${++commits}`) }}><Lab /></Profiler></ThemeProvider>, { title: 'motion-p2', width: 1180, height: 760, focus: false })
