import '../native/local-build.ts'
import { render } from '@gpuix/react'
import { App } from '../App.tsx'
import { ThemeProvider, useMaterial, useTheme, Label } from '../ui.tsx'
import { Button } from '../kit/Button.tsx'
import { connect, set, setPane, getFocusedPaneId, getPaneState, selectPaneThread, useApp } from '../state.ts'
import { setNav } from '../nav/store.ts'
import { onWindowKeyDown } from '../nav/keys.ts'
import { emptyThreadState, type Block } from '../../../../packages/kybern-client/src/transcript.ts'
import type { Thread } from '../../../../packages/kybern-client/src/types.ts'
import { useSplitRoot, collectThreadPanes, maximizePane } from './store.ts'
import { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
import { writeFileSync } from 'node:fs'
writeFileSync(process.env.KYBERN_DATA_DIR! + '/daemon.port', '1')
writeFileSync(process.env.KYBERN_DATA_DIR! + '/daemon.token', 'fixture')
KybernClient.prototype.connect = () => {}
KybernClient.prototype.subscribeEvents = (() => ({ unsubscribe() {}, lastSeq: 0 })) as typeof KybernClient.prototype.subscribeEvents
KybernClient.prototype.call = (async (method: string, p: { thread_id?: string }) => {
  if (method === 'subagents.messages') return []
  if (method === 'threads.get') return { thread: threads.find(t => t.id === p.thread_id), transcript: [], pending_approvals: [], notes: '' }
  if (method === 'threads.target.get') return { target: { provider: parent.provider } }
  if (method === 'settings.get') return { providers: {} }
  return { messages: [], threads: [], providers: [], accounts: [], tasks: [], projects: [], notes: [], skills: [] }
}) as typeof KybernClient.prototype.call
connect()
const at = new Date().toISOString()
const parent = { id: 'parent', title: 'Review pane isolation', project_id: 'project', provider: { kind: 'claude-code', instance: 'default' }, permission_mode: 'supervised', status: 'idle', last_seq: 2, created_at: at, updated_at: at } as Thread
const other = { ...parent, id: 'other', title: 'Independent conversation' }
const child = { ...parent, id: 'child', title: 'Inspect the transport', parent_thread_id: parent.id, subagent: { status: 'completed', task_id: 'child', root_thread_id: 'parent', parent_turn_id: 'turn-parent', started_at: at } } as Thread
const threads = [parent, other, child]
function open(id: string) {
  const thread = threads.find(t => t.id === id)!
  const user: Block = { kind: 'user', id: `u-${id}`, turnId: `turn-${id}`, at, seq: 1, message: { parts: [{ type: 'text', text: `Question for ${id}: keep this conversation in its own pane.` }] } }
  const answer: Block = { kind: 'assistant', id: `a-${id}`, messageId: `a-${id}`, segment: 0, turnId: `turn-${id}`, at, seq: 2, origin: { kind: 'root' }, text: `This is the **${id}** conversation.\n\nIts formatted answer stays readable while another pane changes.`, thinking: '', complete: true }
  return { ...emptyThreadState(), thread, loaded: true, blocks: [user, answer] }
}
async function choose(id: string, keyboard = false) {
  setNav({ keyboardNav: keyboard })
  const pane = getFocusedPaneId()
  await selectPaneThread(pane, id)
  setPane(pane, { open: open(id) })
}
set({ status: 'open', listsLoaded: true, threads: [parent, other], projects: [{ id: 'project', name: 'Split workspace', path: '/tmp', is_git: false, brief_in_all_threads: false, created_at: at, updated_at: at }], selectedId: parent.id, open: open(parent.id) })
setNav({ children: { child }, page: 'home' })
function Fixture() {
  const t = useTheme(), fills = useMaterial(), root = useSplitRoot()
  const focused = useApp(s => s.selectedId)
  return <div testId="split-fixture" style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', backgroundColor: fills.frame }}>
    <div style={{ display: 'flex', height: 30, flexShrink: 0, alignItems: 'center', gap: 8 }}>
      <Button testId="fixture-reset" onClick={() => { maximizePane('main'); void choose('parent') }}>Reset panes</Button><Button testId="fixture-parent" onClick={() => choose('parent')}>Parent</Button><Button testId="fixture-child" onClick={() => choose('child')}>Child</Button><Button testId="fixture-other" onClick={() => choose('other')}>Other</Button><Button testId="fixture-keyboard" onClick={() => choose('parent', true)}>Keyboard parent</Button>
      <text testId="fixture-panes" style={{ color: t.text, fontSize: 8 }}>{JSON.stringify(collectThreadPanes(root).map(p => ({ id: p.id, selected: getPaneState(p.id).selectedId })))}</text>
      <text testId="fixture-focused" style={{ color: t.text }}>{focused ?? 'draft'}</text>
    </div><App />
  </div>
}
render(<ThemeProvider><Fixture /></ThemeProvider>, { title: 'Split verification', width: Number(process.env.PANE_WIDTH ?? 1280), height: 820, focus: false, onKeyDown: onWindowKeyDown })
process.stdin.on('end', () => process.exit(0))
