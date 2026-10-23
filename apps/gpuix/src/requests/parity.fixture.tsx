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
import { Button } from '../kit/Button.tsx'
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
// Evidence only: a picture behind the window, so whole-window glass has something to frost (`shots.ts` sets it).
const WALLPAPER = process.env.FIXTURE_WALLPAPER
const at = '2026-10-15T06:00:00Z'
let mode = 'secret', sequence = 0
let nativeMessages: SubagentMessage[] = []
let deleted = false
let responded = '', queued = ''
const calls: string[] = []
const thread = (id: string, title: string): Thread => ({ id, title, project_id: 'fixture', provider: { kind: 'claude-code', instance: 'default' }, status: 'idle', permission_mode: 'supervised', cwd: '/tmp/fixture', created_at: at, updated_at: at, pinned: false, last_seq: 0 })
const parent = () => thread(`fixture-${sequence}`, 'Request verification')
const child = (): Thread => ({ ...thread('native-child', 'Review the requested changes'), parent_thread_id: parent().id, subagent: { task_id: 'native-task', status: mode === 'native-failed' ? 'failed' : 'running', started_at: at, root_thread_id: parent().id, parent_turn_id: 'turn', stats: { token_count: 18240 }, capabilities: { stop: true, background: true }, agent_type: 'general-purpose', detail: 'Checking permission boundaries and delivery behavior.' } as Thread['subagent'] })
const held = () => ({ id: 'held-1', from_thread_id: 'sender', to_thread_id: parent().id, purpose: 'question', body: 'The implementation is ready for review. Should I include the additional coverage?', state: 'held', delivery: 'queue', created_at: at, updated_at: at, held_reason: 'The sender has broader permissions.' })
const CHAIN = 'pnpm run typecheck && bun test src'
const LONG = 'cd apps/gpuix && pnpm install --frozen-lockfile && pnpm run typecheck && bun test src/transcript --timeout 20000 2>&1 | tee /tmp/gpuix-approval-test.log; git status --short && git diff --stat -- src/transcript/Requests.tsx src/requests/ComposerTray.tsx && rg -n "ApprovalDetail|clampLines" src/transcript'
const PLAN = '## Show the whole command\n\n1. Split chained commands in `ApprovalDetail` on `&&`, `||`, `;` and `|`, one segment per line.\n2. Replace `MoreMenu` with visible option rows and number them.\n3. Send the decline note as `deny.reason`; Codex gets it as a steer message.\n4. Cover each request kind in `parity.fixture.tsx`.\n5. Run the typecheck and the native fixture.'
const approval = (): ApprovalRequest | null => {
  const base = { id: `approval-${sequence}`, thread_id: parent().id, turn_id: 'turn', tool_call_id: 'call', created_at: at, suggestions: [] as unknown[], summary: '' }
  const bash = (command: string, suggestions: unknown[] = [], id = base.id) => ({ ...base, id, tool_name: 'Bash', input: { command, description: 'Run the GPUIX checks' }, suggestions }) as ApprovalRequest
  const session = (...rules: string[]) => [{ type: 'addRules', behavior: 'allow', destination: 'session', rules: rules.map(ruleContent => ({ toolName: 'Bash', ruleContent })) }]
  if (mode === 'codex-command') return { ...base, tool_name: 'shell', input: { command: CHAIN, cwd: '/tmp/fixture' }, suggestions: [] } as ApprovalRequest
  if (mode === 'approval') return bash(CHAIN, session('pnpm run typecheck:*', 'bun test:*'))
  if (mode === 'command') return bash('bun test src/date.test.ts', session('bun test:*'))
  if (mode === 'long') return bash(LONG, session('pnpm install:*', 'pnpm run:*', 'bun test:*', 'tee:*', 'git status:*', 'git diff:*', 'rg:*'))
  if (mode === 'queue') return bash(CHAIN, session('pnpm run typecheck:*', 'bun test:*'))
  if (mode === 'sending') return bash('bun test src/date.test.ts', session('bun test:*'))
  if (mode === 'edit') return { ...base, tool_name: 'Edit', input: { file_path: '/tmp/fixture/src/date.ts', old_string: '  const end = start + days\n  return { start, end }', new_string: '  const end = start + days - 1\n  if (end < start) throw new RangeError(\'empty range\')\n  return { start, end, days }' }, suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] } as ApprovalRequest
  if (mode === 'plan') return { ...base, tool_name: 'ExitPlanMode', input: { plan: PLAN } } as ApprovalRequest
  if (mode === 'connector') return { ...base, tool_name: 'mcp_elicitation', input: { serverName: 'Linear', message: 'Allow Linear to create an issue?', _meta: { codex_approval_kind: 'mcp_tool_call', connector_name: 'Linear', subtitle: 'Linear receives the title and description.', persist: ['session', 'always'] } } } as ApprovalRequest
  if (mode === 'computer') return { ...base, tool_name: 'kybern_computer_use', input: { app: 'Safari', mode: 'background' } } as ApprovalRequest
  if (mode === 'computer-fg') return { ...base, tool_name: 'kybern_computer_use', input: { app: 'Safari', mode: 'foreground' } } as ApprovalRequest
  if (mode === 'note') return { ...base, summary: 'Create the task “Show the full chained command”', tool_name: 'kybern_notes_tasks', input: { action: 'create_task', title: 'Show the full chained command', priority: 2, priority_label: 'High', criteria: 3, preview: 'The approval card summarises a && b to its first segment, so people approve commands they never saw.\n- [ ] Every segment of a chain is visible before approval\n- [ ] Long commands clamp at six lines with a way to expand\n- [ ] Covered in the request parity fixture' } } as ApprovalRequest
  if (mode === 'grant') return { ...base, tool_name: 'external_directory', summary: 'external_directory', input: { permission: 'external_directory', patterns: ['~/.cache/bun/*', '/var/folders/*/T/bun-*'], metadata: {} } } as ApprovalRequest
  if (mode === 'question') return { ...base, tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Where should the tab strip sit?', header: 'Tabs', multiSelect: false, options: [{ label: 'In the thread header', description: 'No extra height; it reads like the title bar while only the chat is open.' }, { label: 'In a 32 px row', description: 'Room for more tabs below the header.' }] }, { question: 'Which tabs may be closed with ⌘W?', header: 'Close', multiSelect: false, options: [{ label: 'Every tab but the chat' }, { label: 'Any tab' }] }] } } as ApprovalRequest
  if (mode === 'question-multi') return { ...base, tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Which checks should run before each commit?', header: 'Checks', multiSelect: true, options: [{ label: 'Typecheck', description: 'tsc --noEmit in apps/gpuix' }, { label: 'Unit tests', description: 'bun test src' }, { label: 'Native fixture', description: 'Launches the requests fixture' }] }] } } as ApprovalRequest
  if (mode === 'secret') return { ...base, tool_name: SECRET_REQUEST_TOOL, input: { label: 'Service API key', reason: 'Needed to connect this project to the service.', env_key: 'SERVICE_API_KEY', file: '.env', replaces: true } } as ApprovalRequest
  if (mode === 'brief') return { ...base, tool_name: COORDINATOR_BRIEF_TOOL, input: { text: 'Build a focused companion for the desktop app.\n\nPreserve keyboard navigation, readable transcripts, and low idle resource use.', replaces: false } } as ApprovalRequest
  if (mode === 'settings') return { ...base, tool_name: COORDINATOR_SETTINGS_TOOL, input: { reason: 'Use separate workspaces for parallel implementation.', changes: [{ path: 'workspace', label: 'Workspace', old: 'shared', new: 'worktree' }, { path: 'review', label: 'Review changes', old: false, new: true }] } } as ApprovalRequest
  if (mode === 'merge') return { ...base, tool_name: LEAD_GIT_TOOL, input: { op: 'merge_pr', number: 108, title: 'Preserve reading position while streaming', checks: { total: 3, passed: 3, failed: 0, pending: 0, skipped: 0 }, method: 'squash' } } as ApprovalRequest
  return null
}
const pendingList = (): ApprovalRequest[] => {
  const first = approval()
  if (!first) return []
  return mode === 'queue' ? [first, { ...first, id: `${first.id}-b` }, { ...first, id: `${first.id}-c` }] : [first]
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
    case 'approvals.respond': responded = `${params.decision}${params.reason ? `:${params.reason}` : ''}`; if (mode !== 'sending') set({ open: { ...getState().open, pendingApprovals: getState().open.pendingApprovals.slice(1) } }); break
    case 'queue.add': queued = params.message?.parts?.[0]?.text ?? ''; break
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
  mode = next; sequence++; calls.length = 0; responded = ''; queued = ''; nativeMessages = mode === 'native-failed' ? [failedMessage()] : []
  setNav({ page: 'home' })
  setTasks({ tasks: { task: task() }, loaded: true, openId: null })
  const th = next.startsWith('native') ? child() : next === 'codex' || next.startsWith('codex-') ? { ...parent(), provider: { kind: 'codex' as const, instance: 'default' } } : next === 'readonly' ? { ...child(), provider: { kind: 'codex' as const, instance: 'default' } } : parent(), request = approval()
  patch({ target: null, accounts: [{ provider: { kind: 'claude-code', instance: 'second' }, name: 'Work account', status: 'signed_in', is_default: false, projects: [], managed: true, can_sign_out: true }] })
  set({ selectedId: th.id, open: { ...emptyThreadState(), thread: th, loaded: true, pendingApprovals: pendingList() } })
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
  return <div testId="fixture-ready" style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', position: 'relative', backgroundColor: WALLPAPER ? 'rgba(0, 0, 0, 0)' : t.surface }}>
    {WALLPAPER && <img src={WALLPAPER} alt="" objectFit="cover" style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%' }} />}
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: 18 }}>{['secret', 'approval', 'command', 'long', 'edit', 'plan', 'connector', 'computer', 'computer-fg', 'note', 'grant', 'question', 'question-multi', 'queue', 'sending', 'codex-command', 'activity', 'permissions', 'limit', 'brief', 'settings', 'merge', 'native-live', 'native-failed', 'readonly', 'details', 'item', 'task-item', 'task-chip'].map(name => <Button key={name} testId={`fixture-${name}`} variant={selected === name ? 'secondary' : 'ghost'} onClick={() => { choose(name); show(name) }}>{name}</Button>)}</div>
    <div style={{ flexGrow: 1 }} />
    {[...new Set(calls)].map(method => <div key={method} testId={`rpc-${method}`} style={{ width: 1, height: 1 }} />)}
    {responded && <div testId={`responded-${responded}`} style={{ width: 1, height: 1 }} />}
    {queued && <div testId={`queued-${queued}`} style={{ width: 1, height: 1 }} />}
    <div style={{ display: 'flex', flexDirection: 'column', width: 736, alignSelf: 'center', paddingBottom: 24 }}>
      {selected === 'task-chip' ? <div style={{ display: 'flex', gap: 8 }}><ThreadContextChips thread={activeThread} /><Button testId="fixture-toggle-task-link" onClick={() => setTasks({ tasks: { task: { ...task(), runs: taskState().tasks.task?.runs.length ? [] : task().runs } } })}>Toggle task link</Button></div> : selected === 'task-item' ? <AgentItemCard result={{ kind: 'task', action: 'updated', id: 'task', key: 'TSK-1', title: 'Linked verification task', createdByThread: null, changes: [], more: 0, projectId: null, status: 'todo', priority: 0, criteriaTotal: 0, criteriaDone: 0 }} inset={false} /> : selected === 'details' ? <virtual-list testId="details-fixture" style={{ width: '100%', height: 570 }}>
        <InboundMessage part={{ type: 'thread_message', message_id: 'reply', from_thread_id: 'reviewer', from_title: 'Review permission boundaries', purpose: 'reply', reply_to: 'sent-message', body: 'The permission checks pass. One shared path needs your attention before integrating.' }} at={at} />
        <SentToRow block={sendBlock} threadId={parent().id} />
        <DelegatedResults items={[resultItem]} at={at} />
      </virtual-list> : selected === 'item' ? <AgentItemCard result={{ kind: 'note', action: 'created', id: 'note', title: 'Permission review', scope: 'project', projectId: 'fixture', threadId: parent().id, createdByThread: parent().id }} inset={false} /> : selected.startsWith('native') ? <NativeSubagentComposer key={activeThread.id + selected} thread={activeThread} /> : selected === 'readonly' ? <SubagentBar thread={activeThread} /> : <ThreadRequests />}
      {!['secret', 'question', 'question-multi', 'brief', 'settings', 'native-live', 'native-failed', 'readonly', 'details', 'item'].includes(selected) && <ComposerView draftKey="fixture" currentThreadId={activeThread.id} provider={parent().provider} providers={[]} accounts={[]} mode="supervised" onModeChange={() => {}} catalogLoading={false} onReloadModels={async () => {}} onSend={async () => {}} />}
      <Label color={t.textTertiary} size={10}>Native fixture · all actions stay in memory</Label>
    </div>
  </div>
}
render(<ThemeProvider><Fixture /></ThemeProvider>, { title: 'Requests verification', width: 1024, height: 820, focus: false, onKeyDown: onWindowKeyDown })
process.stdin.on('end', () => { server.stop(true); process.exit(0) })
process.stdin.on('close', () => { server.stop(true); process.exit(0) })
