// Composer tray lab: the shipped `ComposerTray` (in the composer's stacked surface) and the composer `Attachments` with their
// lightbox, with scripted inputs, for composer-tray-strips.ts (and composer-tray-idle.ts: `LAB_SETTLED=1` starts with nothing
// working, so no loader or clock runs once the transitions settle). Keys: a settle the working subagent · n launch a subagent ·
// y queue a follow-up · q send the first queued follow-up (it leaves) · s show/hide the whole tray. The tray header and the
// tiles are driven with real mouse and key events.
import '../src/native/local-build.ts'
import { render } from '@gpuix/react'
import { Profiler, useState } from 'react'
import type { QueuedMessage, RuntimeTask, Thread } from '../../../packages/kybern-client/src/types.ts'
import { ThemeProvider, useTheme, ink } from '../src/ui.tsx'
import { Attachments } from '../src/Composer.tsx'
import { ComposerTray, trayVisible } from '../src/requests/ComposerTray.tsx'
import { PanelEnter, PanelPresence } from '../src/requests/Panel.tsx'

let commits = 0
const IMAGE = new URL('../../desktop/public/release-background.png', import.meta.url).pathname
const SECOND = new URL('../../desktop/src-tauri/icons/128x128@2x.png', import.meta.url).pathname
const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString()
const sub = (id: string, title: string, type: string, status: string, started: number, ended: number | null, detail?: string): Thread => ({
  id, title, project_id: 'p', provider: { kind: 'claude-code', instance: 'default' }, status: 'idle', permission_mode: 'supervised', cwd: '/tmp', created_at: ago(400), updated_at: ago(1), pinned: false, last_seq: 0, parent_thread_id: 'parent', model: 'claude-haiku-5-5',
  subagent: { task_id: id, root_thread_id: 'parent', parent_turn_id: 'turn', agent_type: type, status, started_at: ago(started), completed_at: ended === null ? null : ago(ended), capabilities: { stop: true, background: true }, ...(detail ? { result: detail, detail } : {}) },
}) as never
const task: RuntimeTask = { id: 'task', thread_id: 'parent', origin_turn_id: 'turn', started_seq: 1, updated_seq: 1, kind: 'process', status: 'running', title: 'cd /Users/mymac/projects/ade-motion-fps/apps/gpuix && MOTION_SHOTS=1 bun scripts/motion-p2-strips.ts --theme both', backgrounded: true, stats: {}, capabilities: { stop: true }, started_at: ago(95), updated_at: ago(1) } as never
const queued = (n: number): QueuedMessage => ({ id: `q${n}`, thread_id: 'parent', message: { parts: [{ type: 'text', text: `Follow-up ${n}: also cover the Reduce Motion path in the strip runner.` }] } })
const attachment = (n: number, path: string) => ({ id: `a${n}`, name: n === 1 ? 'release-background.png' : 'icon.png', media_type: 'image/png', size: 1024, label: `image${n}`, path })

function Lab() {
  const t = useTheme()
  const settled = process.env.LAB_SETTLED === '1'
  const [measureDone, setMeasureDone] = useState(settled)
  const [extra, setExtra] = useState(0)
  const [queue, setQueue] = useState<QueuedMessage[]>([queued(1)])
  const [queueN, setQueueN] = useState(2)
  const [shown, setShown] = useState(true)
  const subagents = [
    sub('s1', 'Study zeron/zui/zed animation architecture', 'Explore', 'completed', 382, 180),
    sub('s2', 'Measure tray frame cost while the answer streams', 'general-purpose', measureDone ? 'completed' : 'running', 74, measureDone ? 0 : null),
    ...Array.from({ length: extra }, (_, i) => sub(`x${i}`, `Review the composer lightbox ${i + 1}`, 'Explore', 'running', 2, null)),
  ]
  const data = { threadId: 'lab', subagents, tasks: settled ? [] : [task], helpers: [], queued: queue }
  const key = (k: string) => {
    if (k === 'a') setMeasureDone(v => !v)
    if (k === 'n') setExtra(n => n + 1)
    if (k === 'y') { setQueue(list => [...list, queued(queueN)]); setQueueN(n => n + 1) }
    if (k === 'q') setQueue(list => list.slice(1))
    if (k === 's') setShown(v => !v)
  }
  const border = t.variant === 'dark' ? 'rgba(252, 252, 252, 0.052)' : 'rgba(13, 13, 13, 0.076)'
  return (
    <div testId="app-ready" onKeyDown={e => key(e.key ?? '')} style={{ position: 'relative', width: '100%', height: '100%', backgroundColor: t.surface }}>
      {/* The tray, bottom-anchored on a composer card like the thread view. */}
      <div style={{ position: 'absolute', left: 40, top: 20, width: 736, height: 420, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', alignItems: 'center' }}>
        <PanelPresence show={shown && trayVisible(data)}><PanelEnter>
          <div testId="tray-frame" style={{ display: 'flex', flexDirection: 'column', width: '93.333%', alignSelf: 'center', marginBottom: -1, borderWidth: 1, borderBottomWidth: 0, borderColor: border, borderTopLeftRadius: 18.2, borderTopRightRadius: 18.2, backgroundColor: t.popover }}>
            <ComposerTray data={data} />
          </div>
        </PanelEnter></PanelPresence>
        <div style={{ display: 'flex', width: '100%', height: 96, borderRadius: 19.2, borderWidth: 1, borderColor: border, backgroundColor: t.variant === 'dark' ? t.composer : '#ffffff' }} />
      </div>
      {/* Attachments in a composer card for the lightbox. */}
      <div testId="attachments-card" style={{ position: 'absolute', left: 40, top: 520, width: 736, display: 'flex', flexDirection: 'column', paddingTop: 14, paddingLeft: 16, paddingRight: 16, paddingBottom: 40, borderRadius: 19.2, borderWidth: 1, borderColor: border, backgroundColor: t.variant === 'dark' ? t.composer : '#ffffff' }}>
        <Attachments items={[attachment(1, IMAGE), attachment(2, SECOND)]} uploading={0} onRemove={() => {}} />
        <div style={{ height: 1, backgroundColor: ink(t, 0) }} />
      </div>
    </div>
  )
}
render(<ThemeProvider><Profiler id="lab" onRender={() => { console.error(`[lab-commit] ${++commits}`) }}><Lab /></Profiler></ThemeProvider>, { title: 'composer-tray', width: 1180, height: 760, focus: false })
