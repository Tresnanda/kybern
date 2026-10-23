// Native fixture for the typing guard: a thread page (requests stack + composer, hidden while a card takes it, as `App.tsx` does)
// where buttons make a question (with a deadline) or a password prompt arrive, and answer it. An in-process socket answers the
// daemon, so nothing real is touched. Drive it with `typing.verify.ts`.
import '../native/local-build.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { render } from '@gpuix/react'
import { PROTOCOL_VERSION, type ApprovalRequest, type Thread } from '../../../../packages/kybern-client/src/types.ts'
import { emptyThreadState } from '../../../../packages/kybern-client/src/transcript.ts'
import { connect, getState, set, useApp } from '../state.ts'
import { ThemeProvider, useTheme, Label } from '../ui.tsx'
import { Button } from '../kit/Button.tsx'
import { ThreadRequests, useBlockingRequest } from '../transcript/Requests.tsx'
import { ComposerView } from '../Composer.tsx'
import { onWindowKeyDown } from '../nav/keys.ts'

const at = '2026-10-23T02:00:00Z'
let sequence = 0
let acted: string[] = []
const later = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString()
const thread = (): Thread => ({ id: 'typing-thread', title: 'Pick the tab strip layout', project_id: 'fixture', provider: { kind: 'claude-code', instance: 'default' }, status: 'awaiting-approval', permission_mode: 'supervised', cwd: '/tmp/fixture', created_at: at, updated_at: at } as unknown as Thread)

const QUESTION = { questions: [{ question: 'Where should the tab strip sit?', header: 'Tabs', multiSelect: false, options: [{ label: 'In the thread header', description: 'No extra height; it reads like the title bar.' }, { label: 'In a 32 px row', description: 'Room for more tabs below the header.' }] }] }
const SUDO = { purpose: 'sudo', prompt: '[sudo] password for mymac:', secret: true, confirm: false, command: 'sudo brew services start postgresql@17', harness: 'Claude Code', attempt: 1, wait_seconds: 300 }

function arrive(kind: 'question' | 'password') {
  sequence++
  const base = { id: `approval-${sequence}`, thread_id: thread().id, turn_id: 'turn', tool_call_id: 'call', created_at: at, suggestions: [], summary: '' }
  const approval = (kind === 'question'
    ? { ...base, tool_name: 'AskUserQuestion', input: { ...QUESTION, deadline: { defaults: { 'Where should the tab strip sit?': 'In a 32 px row' }, seconds: 600, started_at: later(0), ends_at: later(600) } } }
    : { ...base, tool_name: 'kybern_askpass', input: SUDO }) as ApprovalRequest
  set({ open: { ...getState().open, pendingApprovals: [approval] } })
}
const answer = () => set({ open: { ...getState().open, pendingApprovals: [] } })

const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(req, s) { if (s.upgrade(req)) return; return new Response('fixture') }, websocket: { message(ws, raw) {
  const request = JSON.parse(String(raw)); let result: unknown = {}; const params = request.params ?? {}
  switch (request.method) {
    case 'daemon.info': result = { protocol_version: PROTOCOL_VERSION, environment_id: 'typing-fixture', version: 'fixture' }; break
    case 'projects.list': result = { projects: [] }; break
    case 'threads.list': result = { threads: [thread()] }; break
    case 'threads.messages.list': result = { messages: [] }; break
    case 'threads.target.get': result = { target: { provider: thread().provider }, pending_permission_mode: null, quota_limited: false }; break
    case 'tasks.list': result = { tasks: [] }; break
    case 'events.subscribe': result = { subscription_id: 'fixture', head_seq: 0, replay_ready: true }; break
    case 'requests.progress': result = { items: [] }; break
    case 'requests.act': acted = [...acted, String(params.action)]; break
  }
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }))
  set({ statusDetail: `${request.method}:${Date.now()}` })
} } })
process.env.KYBERN_URL = `ws://127.0.0.1:${server.port}/ws`
process.env.KYBERN_TOKEN = 'fixture'
if (!process.env.KYBERN_DATA_DIR) throw Error('Fixture requires an isolated data directory')
mkdirSync(process.env.KYBERN_DATA_DIR, { recursive: true })
writeFileSync(path.join(process.env.KYBERN_DATA_DIR, 'daemon.port'), String(server.port))
writeFileSync(path.join(process.env.KYBERN_DATA_DIR, 'daemon.token'), 'fixture', { mode: 0o600 })
connect()
const th = thread()
set({ selectedId: th.id, threads: [th], open: { ...emptyThreadState(), thread: th, loaded: true, pendingApprovals: [] } })

function Fixture() {
  useApp((s) => s.statusDetail)
  const t = useTheme()
  const active = useApp((s) => s.open.thread)!
  const blocking = useBlockingRequest()
  return <div testId="fixture-ready" style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', backgroundColor: t.surface }}>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: 14 }}>
      <Button size="sm" testId="arrive-question" onClick={() => arrive('question')}>Question arrives</Button>
      <Button size="sm" testId="arrive-password" onClick={() => arrive('password')}>Password arrives</Button>
      <Button size="sm" testId="answer" onClick={answer}>Answer</Button>
    </div>
    <div testId="acted" style={{ width: 1, height: 1 }}><Label color={t.surface} size={1}>{acted.join(',') || '-'}</Label></div>
    <div testId="blocking" style={{ width: 1, height: 1 }}><Label color={t.surface} size={1}>{blocking ? 'yes' : 'no'}</Label></div>
    <div style={{ flexGrow: 1 }} />
    <div style={{ display: 'flex', flexDirection: 'column', width: 700, alignSelf: 'center', paddingBottom: 24 }}>
      <ThreadRequests />
      {!blocking && <ComposerView draftKey="typing" currentThreadId={active.id} provider={active.provider} providers={[]} accounts={[]} mode="supervised" onModeChange={() => {}} catalogLoading={false} onReloadModels={async () => {}} onSend={async () => {}} />}
    </div>
  </div>
}
render(<ThemeProvider><Fixture /></ThemeProvider>, { title: 'Typing guard', width: 1024, height: 620, focus: false, onKeyDown: onWindowKeyDown })
process.stdin.on('end', () => { server.stop(true); process.exit(0) })
process.stdin.on('close', () => { server.stop(true); process.exit(0) })
