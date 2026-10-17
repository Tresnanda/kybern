// Deterministic native fixtures; no connection or writes to any real daemon.
import '../native/local-build.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { render } from '@gpuix/react'
import { useState } from 'react'
import { PROTOCOL_VERSION, SECRET_REQUEST_TOOL, COORDINATOR_BRIEF_TOOL, COORDINATOR_SETTINGS_TOOL, LEAD_GIT_TOOL, type Thread, type ApprovalRequest, type AgentResultItem, type SubagentMessage } from '../../../../packages/kybern-client/src/types.ts'
import { emptyThreadState } from '../../../../packages/kybern-client/src/transcript.ts'
import { connect, set, getState, useApp } from '../state.ts'
import { patch } from '../composer/store.ts'
import { ThemeProvider, useTheme, Label } from '../ui.tsx'
import { Button } from '../transcript/kit.tsx'
import { ThreadRequests } from '../transcript/Requests.tsx'
import { ComposerView } from '../Composer.tsx'
import { NativeSubagentComposer } from '../subagents/Composer.tsx'
import { SubagentBar } from '../subagents/Page.tsx'
import { InboundMessage, DelegatedResults, SentToRow } from '../transcript/Messages.tsx'
import { NotesPage } from '../notes/NotesPage.tsx'
import { TasksPage } from '../tasks/TasksPage.tsx'
import { setTasks, taskState, useTasksFeed } from '../tasks/store.ts'
import { useNotesFeed } from '../notes/store.ts'
import { ThreadContextChips } from '../coordinator/Header.tsx'
import { useNav, setNav } from '../nav/store.ts'
import type { TaskItem } from '../../../../packages/kybern-client/src/types.ts'
import { AgentItemCard } from '../coordinator/AgentItem.tsx'
import { LaunchMember } from '../subagents/Launch.tsx'
import type { ToolBlock } from '../transcript/store.ts'
import { onWindowKeyDown } from '../nav/keys.ts'
const at = '2026-10-15T06:00:00Z'
let mode = 'secret', sequence = 0
let nativeMessages: SubagentMessage[] = []
let deleted = false
const calls: string[] = []
const thread = (id: string, title: string): Thread => ({ id, title, project_id: 'fixture', provider: { kind: 'claude-code', instance: 'default' }, status: 'idle', permission_mode: 'supervised', cwd: '/tmp/fixture', created_at: at, updated_at: at, pinned: false, last_seq: 0 })
const parent = () => thread(`fixture-${sequence}`, 'Request verification')
const child = (): Thread => ({ ...thread('native-child', 'Review the requested changes'), parent_thread_id: parent().id, subagent: { task_id: 'native-task', status: mode === 'native-failed' ? 'failed' : 'running', started_at: at, root_thread_id: parent().id, parent_turn_id: 'turn', stats: { token_count: 18240 }, capabilities: { stop: true, background: true }, agent_type: 'general-purpose', detail: 'Checking permission boundaries and delivery behavior.' } as Thread['subagent'] })
const held = () => ({ id: 'held-1', from_thread_id: 'sender', to_thread_id: parent().id, purpose: 'question', body: 'The implementation is ready for review. Should I include the additional coverage?', state: 'held', delivery: 'queue', created_at: at, updated_at: at, held_reason: 'The sender has broader permissions.' })
const approval = (): ApprovalRequest | null => {
  const base = { id: `approval-${sequence}`, thread_id: parent().id, turn_id: 'turn', tool_call_id: 'call', created_at: at, suggestions: [], summary: '' }
  if (mode === 'secret') return { ...base, tool_name: SECRET_REQUEST_TOOL, input: { label: 'Service API key', reason: 'Needed to connect this project to the service.', env_key: 'SERVICE_API_KEY', file: '.env', replaces: true } } as ApprovalRequest
  if (mode === 'brief') return { ...base, tool_name: COORDINATOR_BRIEF_TOOL, input: { text: 'Build a focused companion for the desktop app.\n\nPreserve keyboard navigation, readable transcripts, and low idle resource use.', replaces: false } } as ApprovalRequest
  if (mode === 'settings') return { ...base, tool_name: COORDINATOR_SETTINGS_TOOL, input: { reason: 'Use separate workspaces for parallel implementation.', changes: [{ path: 'workspace', label: 'Workspace', old: 'shared', new: 'worktree' }, { path: 'review', label: 'Review changes', old: false, new: true }] } } as ApprovalRequest
  if (mode === 'merge') return { ...base, tool_name: LEAD_GIT_TOOL, input: { op: 'merge_pr', number: 108, title: 'Preserve reading position while streaming', checks: { total: 3, passed: 3, failed: 0, pending: 0, skipped: 0 }, method: 'squash' } } as ApprovalRequest
  return null
}
const resultItem: AgentResultItem = { task_id: 'result', thread_id: 'reviewer', title: 'Review permission boundaries', provider: 'codex', model: 'GPT-6 Sol', role: 'review', status: 'completed', result: '### Review complete\n\nThe request stays pending until the user submits. Credentials remain outside the transcript.\n\n- Verified cancellation.\n- Checked retry behavior.', workspace: 'worktree', branch: 'kybern/review-permissions', base_commit: '12345678abcdef', head_commit: '87654321fedcba', diffstat: { files: 2, additions: 24, deletions: 4 }, files_touched: ['src/requests/Secret.tsx', 'src/requests/verify.ts'], conflicts: [{ path: 'src/requests/Secret.tsx', owner_thread_id: 'owner', at }] }
const sendBlock: ToolBlock = { kind: 'tool', id: 'sent-call', turnId: 'turn', at, seq: 1, origin: { kind: 'root' }, call: { id: 'sent-call', name: 'kybern_thread_send', input: { thread_id: 'reviewer', body: 'Please review the permission boundaries before we proceed.', purpose: 'question' } }, complete: true, isError: false, stream: '', output: { message_id: 'sent-message', delivered_as: 'held', state: 'held' } }
const failedMessage = (): SubagentMessage => ({ id: 'undelivered', thread_id: 'native-child', root_thread_id: parent().id, task_id: 'native-task', native_task_id: 'native-task', session_instance_id: 'fixture', turn_id: 'turn', message: { parts: [{ type: 'text', text: 'Please include cancellation coverage.' }] }, status: 'failed', error: 'The subagent finished before receiving this message.', parent_message_id: null, parent_queued: false, created_at: at, updated_at: at })
const task = (): TaskItem => ({ id: 'task', key: 'TSK-1', title: 'Linked verification task', body: 'Verify navigation.', scope: 'global', status: 'todo', priority: 0, rank: 0, note_ids: [], runs: [{ thread_id: parent().id, number: 1, provider: parent().provider, started_at: at, state: 'completed' }], revision: 1, created_at: at, updated_at: at, status_changed_at: at })
const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(req, s) { if (s.upgrade(req)) return; return new Response('fixture') }, websocket: { message(ws, raw) {
  const request = JSON.parse(String(raw)); let result: unknown = {}; const params = request.params ?? {}
  calls.push(request.method)
  switch (request.method) {
    case 'daemon.info': result = { protocol_version: PROTOCOL_VERSION, environment_id: 'requests-fixture', version: 'fixture' }; break
    case 'projects.list': result = { projects: [] }; break
    case 'threads.list': result = { threads: params.parent_thread_id && mode === 'activity' ? [child(), { ...thread('helper', 'Check the docs'), parent_thread_id: parent().id }] : [] }; break
    case 'threads.messages.list': result = { messages: mode === 'activity' ? [held()] : [] }; break
    case 'threads.target.get': result = { target: { provider: parent().provider }, pending_permission_mode: mode === 'permissions' ? 'full-access' : null, quota_limited: mode === 'limit' }; break
    case 'subagents.messages': result = nativeMessages; break
    case 'subagents.send': { const message = { ...failedMessage(), id: params.id, status: 'pending' as const, error: null, message: params.message }; nativeMessages = [...nativeMessages, message]; result = message; break }
    case 'subagents.send_to_parent': { const message = { ...nativeMessages[0]!, parent_queued: true }; nativeMessages = [message]; result = message; break }
    case 'notes.list': result = { notes: deleted ? [] : [{ id: 'note', title: 'Permission review', body: 'Keep secrets outside transcripts. Verify cancellation and idempotent retries.', scope: 'project', project_id: 'fixture', revision: 1, created_at: at, updated_at: at }] }; break
    case 'tasks.items.get': result = { task: task() }; break
    case 'tasks.items.list': result = { tasks: [task()] }; break
    case 'notes.get': result = { note: deleted ? null : { id: 'note', title: 'Permission review', body: 'Keep secrets outside transcripts. Verify cancellation and idempotent retries.', scope: 'project', project_id: 'fixture', revision: 1, created_at: at, updated_at: at } }; break
    case 'notes.delete': deleted = true; break
    case 'notes.restore': deleted = false; result = { id: 'note', title: 'Permission review' }; break
    case 'tasks.list': result = { tasks: mode === 'activity' ? [{ id: 'process', thread_id: parent().id, turn_id: 'turn', title: 'Running focused checks', kind: 'process', status: 'running', started_at: at, updated_at: at, capabilities: { stop: true }, stats: {} }] : [] }; break
    case 'events.subscribe': result = { subscription_id: 'fixture', head_seq: 0, replay_ready: true }; break
    case 'threads.messages.deliver': case 'threads.messages.dismiss': result = held(); break
    case 'approvals.respond': set({ open: { ...getState().open, pendingApprovals: [] } }); break
    case 'threads.permissions.apply': mode = 'quiet'; result = parent(); break
    case 'threads.switch_continue': mode = 'quiet'; break
  }
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }))
  set({ statusDetail: `${request.method}:${calls.length}` })
} } })
process.env.KYBERN_URL = `ws://127.0.0.1:${server.port}/ws`
process.env.KYBERN_TOKEN = 'fixture'
if (!process.env.KYBERN_DATA_DIR) throw Error('Fixture requires an isolated data directory')
mkdirSync(process.env.KYBERN_DATA_DIR, { recursive: true })
writeFileSync(path.join(process.env.KYBERN_DATA_DIR, 'daemon.port'), String(server.port))
writeFileSync(path.join(process.env.KYBERN_DATA_DIR, 'daemon.token'), 'fixture', { mode: 0o600 })
connect()
function show(next: string) {
  mode = next; sequence++; calls.length = 0; nativeMessages = mode === 'native-failed' ? [failedMessage()] : []
  setNav({ page: 'home' })
  setTasks({ tasks: { task: task() }, loaded: true, openId: null })
  const th = next.startsWith('native') ? child() : next === 'readonly' ? { ...child(), provider: { kind: 'codex' as const, instance: 'default' } } : parent(), request = approval()
  patch({ target: null, accounts: [{ provider: { kind: 'claude-code', instance: 'second' }, name: 'Work account', status: 'signed_in', is_default: false, projects: [], managed: true, can_sign_out: true }] })
  set({ selectedId: th.id, open: { ...emptyThreadState(), thread: th, loaded: true, pendingApprovals: request ? [request] : [] } })
}
show(mode)
function Fixture() {
  useNotesFeed()
  useTasksFeed()
  useApp(s => s.statusDetail)
  const t = useTheme(), [selected, choose] = useState(mode)
  const page = useNav(s => s.page)
  const activeThread = useApp(s => s.open.thread)!
  if (page === 'notes') return <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', backgroundColor: t.surface }}><Button testId="fixture-back" onClick={() => setNav({ page: 'home' })}>Back</Button><NotesPage /></div>
  if (page === 'tasks') return <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', backgroundColor: t.surface }}><Button testId="fixture-back" onClick={() => setNav({ page: 'home' })}>Back</Button><TasksPage /></div>
  return <div testId="fixture-ready" style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', backgroundColor: t.surface }}>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: 18 }}>{['secret', 'activity', 'permissions', 'limit', 'brief', 'settings', 'merge', 'native-live', 'native-failed', 'readonly', 'details', 'item', 'task-item', 'task-chip'].map(name => <Button key={name} testId={`fixture-${name}`} variant={selected === name ? 'default' : 'ghost'} onClick={() => { choose(name); show(name) }}>{name}</Button>)}</div>
    <div style={{ flexGrow: 1 }} />
    {[...new Set(calls)].map(method => <div key={method} testId={`rpc-${method}`} style={{ width: 1, height: 1 }} />)}
    <div style={{ display: 'flex', flexDirection: 'column', width: 736, alignSelf: 'center', paddingBottom: 24 }}>
      {selected === 'task-chip' ? <div style={{ display: 'flex', gap: 8 }}><ThreadContextChips thread={activeThread} /><Button testId="fixture-toggle-task-link" onClick={() => setTasks({ tasks: { task: { ...task(), runs: taskState().tasks.task?.runs.length ? [] : task().runs } } })}>Toggle task link</Button></div> : selected === 'task-item' ? <AgentItemCard result={{ kind: 'task', action: 'updated', id: 'task', key: 'TSK-1', title: 'Linked verification task', createdByThread: null, changes: [], more: 0, projectId: null, status: 'todo', priority: 0, criteriaTotal: 0, criteriaDone: 0 }} inset={false} /> : selected === 'details' ? <virtual-list testId="details-fixture" style={{ width: '100%', height: 570 }}>
        <InboundMessage part={{ type: 'thread_message', message_id: 'reply', from_thread_id: 'reviewer', from_title: 'Review permission boundaries', purpose: 'reply', reply_to: 'sent-message', body: 'The permission checks pass. One shared path needs your attention before integrating.' }} at={at} />
        <SentToRow block={sendBlock} threadId={parent().id} />
        <DelegatedResults items={[resultItem]} at={at} />
      </virtual-list> : selected === 'item' ? <AgentItemCard result={{ kind: 'note', action: 'created', id: 'note', title: 'Permission review', scope: 'project', projectId: 'fixture', threadId: parent().id, createdByThread: parent().id }} inset={false} /> : selected.startsWith('native') ? <NativeSubagentComposer key={activeThread.id + selected} thread={activeThread} /> : selected === 'readonly' ? <SubagentBar thread={activeThread} /> : <ThreadRequests />}
      {!['secret', 'brief', 'settings', 'native-live', 'native-failed', 'readonly', 'details', 'item'].includes(selected) && <ComposerView draftKey="fixture" provider={parent().provider} providers={[]} accounts={[]} mode="supervised" onModeChange={() => {}} catalogLoading={false} onReloadModels={async () => {}} onSend={async () => {}} />}
      <Label color={t.textTertiary} size={10}>Native fixture · all actions stay in memory</Label>
    </div>
  </div>
}
render(<ThemeProvider><Fixture /></ThemeProvider>, { title: 'Requests verification', width: 1024, height: 820, focus: false, onKeyDown: onWindowKeyDown })
process.stdin.on('end', () => { server.stop(true); process.exit(0) })
process.stdin.on('close', () => { server.stop(true); process.exit(0) })
