import '../native/local-build.ts'
import { render } from '@gpuix/react'
import { emptyThreadState, type Block } from '../../../../packages/kybern-client/src/transcript.ts'
import type { Thread } from '../../../../packages/kybern-client/src/types.ts'
import { getPaneState, set, setPane, getFocusedPaneId } from '../state.ts'
import { Transcript } from '../Transcript.tsx'
import { ThemeProvider, useTheme } from '../ui.tsx'
import { SplitWorkspace } from './Workspace.tsx'
import { startSplitView, splitPane } from './store.ts'
const at = new Date().toISOString()
const thread = { id: 'stream-fixture', title: 'Streaming', project_id: 'fixture', provider: { kind: 'claude-code', instance: 'default' }, status: 'running', permission_mode: 'supervised', created_at: at, updated_at: at } as Thread
const user: Block = { kind: 'user', id: 'u', turnId: 'turn', at, seq: 1, message: { parts: [{ type: 'text', text: 'Explain paced streaming.' }] } }
const answer: Block = { kind: 'assistant', id: 'a', messageId: 'a', segment: 0, turnId: 'turn', at, seq: 2, origin: { kind: 'root' }, text: '', thinking: '', complete: false }
set({ status: 'open', selectedId: thread.id, threads: [thread], open: { ...emptyThreadState(), loaded: true, thread, blocks: [user, answer] } })
startSplitView()
splitPane('main', 'horizontal')
const second = getFocusedPaneId()
setPane(second, { selectedId: 'stream-two', open: { ...getPaneState('main').open, thread: { ...thread, id: 'stream-two', title: 'Second stream' } } })
let n = 0
const timer = setInterval(() => {
  n++
  const text = Array.from({ length: n }, (_, i) => `Word ${i}: smooth output preserves **formatting** and Unicode 🌿. `).join('')
  for (const id of ['main', second]) setPane(id, { open: { ...getPaneState(id).open, blocks: [user, { ...answer, text: id === 'main' ? text : 'Second pane: ' + text }] } })
}, 300)
function Fixture() { const t = useTheme(); return <div testId="stream-ready" style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', backgroundColor: t.surface }}><SplitWorkspace><Transcript /></SplitWorkspace></div> }
render(<ThemeProvider><Fixture /></ThemeProvider>, { title: 'Streaming parity', width: 1280, height: 820, focus: false })
process.stdin.on('end', () => { clearInterval(timer); process.exit(0) })
