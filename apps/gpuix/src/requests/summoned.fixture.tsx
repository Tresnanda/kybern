// Deterministic native fixture for the summoned cards (sign-in, password prompt, macOS permission, deadline), their transcript
// records, the sign-in chip and the Settings rows. No connection or writes to any real daemon: an in-process socket answers.
// Drive it with `summoned.shots.ts`.
import '../native/local-build.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { render } from '@gpuix/react'
import { useState } from 'react'
import { PROTOCOL_VERSION, type ApprovalDecision, type ApprovalRequest, type RequestProgress, type Settings, type Thread } from '../../../../packages/kybern-client/src/types.ts'
import { emptyThreadState, type Block } from '../../../../packages/kybern-client/src/transcript.ts'
import { connect, set, getState, useApp } from '../state.ts'
import { ThemeProvider, useTheme, Label } from '../ui.tsx'
import { Button } from '../kit/Button.tsx'
import { ThreadRequests } from '../transcript/Requests.tsx'
import { ComposerView } from '../Composer.tsx'
import { WorkRows, type RowContext } from '../transcript/rows.tsx'
import { signInRows } from '../../../../packages/kybern-client/src/signIn.ts'
import { AskDeadlineSection } from '../settings/primary.tsx'
import { setSettings } from '../settings/store.ts'
import { onWindowKeyDown } from '../nav/keys.ts'
import { applyProgress, forgetProgress } from './progress.ts'

const WALLPAPER = process.env.FIXTURE_WALLPAPER
const at = '2026-10-23T02:00:00Z'
let mode = process.env.FIXTURE_MODE ?? 'login-ask', sequence = 0
let responded = '', acted = '', queued = ''
const thread = (): Thread => ({ id: `fixture-${sequence}`, title: 'Install the Postgres service', project_id: 'fixture', provider: { kind: 'claude-code', instance: 'default' }, status: 'awaiting-approval', permission_mode: 'supervised', cwd: '/tmp/fixture', created_at: at, updated_at: at, pinned: false, last_seq: 0 } as Thread)
const later = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString()

const LOGIN = { cli: 'gh', service: 'GitHub', reason: 'Claude needs it to open the pull request for feat/ade-69-71.', account: 'github.com, any account you choose', access: 'repo, read:org, workflow', signs_in: '`gh` for this Mac, so your terminal uses it too', command: 'gh auth login --web', methods: ['browser', 'terminal'] }
const SUPABASE = { ...LOGIN, cli: 'supabase', service: 'Supabase', access: null, signs_in: '`supabase` for this Mac', command: 'supabase login' }
const SUDO = { purpose: 'sudo', prompt: '[sudo] password for mymac:', secret: true, confirm: false, command: 'sudo brew services start postgresql@17', harness: 'Claude Code', attempt: 1, wait_seconds: 300 }
const PERMISSION = { pane: 'camera', app: 'Anamorphia', bundle_id: 'com.anamorphia.gallery', reason: 'The scan screen needs the camera so I can test the capture flow in the simulator build.', pane_label: 'Privacy & Security › Camera', url: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera', needs_app_added: false, relaunch: false, detects: true }
const QUESTION = { questions: [{ question: 'Where should the tab strip sit?', header: 'Tabs', multiSelect: false, options: [{ label: 'In the thread header', description: 'No extra height; it reads like the title bar.' }, { label: 'In a 32 px row', description: 'Room for more tabs below the header.' }] }] }

function card(): { approval: ApprovalRequest; progress?: Partial<RequestProgress> } | null {
  const base = { id: `approval-${sequence}`, thread_id: thread().id, turn_id: 'turn', tool_call_id: 'call', created_at: at, suggestions: [], summary: '' }
  const a = (tool_name: string, input: unknown) => ({ ...base, tool_name, input }) as ApprovalRequest
  switch (mode) {
    case 'login-ask': return { approval: a('kybern_request_login', LOGIN) }
    case 'login-wait': return { approval: a('kybern_request_login', LOGIN), progress: { kind: 'login', phase: 'waiting', method: 'browser', user_code: '8F2C-41AB', url: 'https://github.com/login/device', ends_at: later(852) } }
    case 'login-terminal': return { approval: a('kybern_request_login', LOGIN), progress: { kind: 'login', phase: 'waiting', method: 'terminal', terminal: { id: 'term-1', cwd: '/tmp', cols: 100, rows: 24, title: 'gh auth login', alive: true, created_at: at }, ends_at: later(852) } }
    case 'login-paste': return { approval: a('kybern_request_login', SUPABASE), progress: { kind: 'login', phase: 'paste_code', method: 'browser' } }
    case 'login-done': return { approval: a('kybern_request_login', LOGIN), progress: { kind: 'login', phase: 'done', account: 'Tresnanda' } }
    case 'login-failed': return { approval: a('kybern_request_login', LOGIN), progress: { kind: 'login', phase: 'failed', error: 'The browser sign-in was cancelled. Try again, or sign in from a terminal to see what `gh` says.' } }
    case 'password-sudo': return { approval: a('kybern_askpass', SUDO) }
    case 'password-wrong': return { approval: a('kybern_askpass', { ...SUDO, attempt: 2 }) }
    case 'password-passphrase': return { approval: a('kybern_askpass', { ...SUDO, purpose: 'ssh_passphrase', prompt: "Enter passphrase for key '/Users/mymac/.ssh/id_ed25519':", command: 'git push origin feat/ade-69-71', harness: 'Codex' }) }
    case 'password-hostkey': return { approval: a('kybern_askpass', { ...SUDO, purpose: 'ssh_host_key', confirm: true, secret: false, prompt: 'Are you sure you want to continue connecting (yes/no)?', command: 'ssh deploy@203.0.113.24 "systemctl restart gallery"', host: '203.0.113.24', key_type: 'ED25519', fingerprint: 'SHA256:p2Qk7v1fZ0Yx9mDcR8Lh3uWnB4tE6sJaKqV5oGiXy1M' }) }
    case 'password-git-user': return { approval: a('kybern_askpass', { ...SUDO, purpose: 'git_username', secret: false, prompt: "Username for 'https://git.studio-example.net':", command: 'git fetch studio --tags', host: 'git.studio-example.net', harness: 'Pi' }) }
    case 'password-git-pass': return { approval: a('kybern_askpass', { ...SUDO, purpose: 'git_password', prompt: "Password for 'https://tresnanda@git.studio-example.net':", command: 'git fetch studio --tags', host: 'git.studio-example.net', harness: 'Pi' }) }
    case 'permission-ask': return { approval: a('kybern_request_permission', PERMISSION) }
    case 'permission-wait': return { approval: a('kybern_request_permission', PERMISSION), progress: { kind: 'permission', phase: 'waiting', url: PERMISSION.url } }
    case 'permission-done': return { approval: a('kybern_request_permission', PERMISSION), progress: { kind: 'permission', phase: 'done' } }
    case 'permission-off': return { approval: a('kybern_request_permission', { ...PERMISSION, pane: 'screen_recording', pane_label: 'Privacy & Security › Screen & System Audio Recording', relaunch: true }), progress: { kind: 'permission', phase: 'not_granted' } }
    case 'permission-fda': return { approval: a('kybern_request_permission', { ...PERMISSION, pane: 'full_disk_access', app: 'the Kybern CLI', bundle_id: null, app_path: '/Applications/Kybern.app/Contents/MacOS/kybern', pane_label: 'Privacy & Security › Full Disk Access', reason: 'The migration reads Mail’s database under ~/Library to test the importer.', needs_app_added: true }) }
    case 'deadline': return { approval: a('AskUserQuestion', { ...QUESTION, deadline: { defaults: { 'Where should the tab strip sit?': 'In a 32 px row' }, seconds: 600, started_at: later(-19), ends_at: later(581) } }), progress: { kind: 'question', phase: 'asking', ends_at: later(581) } }
    case 'deadline-paused': return { approval: a('AskUserQuestion', { ...QUESTION, deadline: { defaults: { 'Where should the tab strip sit?': 'In a 32 px row' }, seconds: 600, started_at: later(-19), ends_at: later(581) } }), progress: { kind: 'question', phase: 'paused', remaining_ms: 581_000 } }
    case 'deadline-last': return { approval: a('AskUserQuestion', { ...QUESTION, deadline: { defaults: { 'Where should the tab strip sit?': 'In a 32 px row' }, seconds: 600, started_at: later(-558), ends_at: later(42) } }), progress: { kind: 'question', phase: 'asking', ends_at: later(42) } }
  }
  return null
}

/** Resolved approvals and failed tool rows, as the transcript shows them. */
function recordBlocks(): Block[] {
  const tid = thread().id
  let seq = 0
  const resolved = (tool_name: string, input: unknown, decision: ApprovalDecision): Block => ({ kind: 'approval', id: `rec-${++seq}`, turnId: 'turn', at, seq, approval: { id: `rec-${seq}`, thread_id: tid, turn_id: 'turn', tool_name, input, summary: '', suggestions: [], created_at: at } as ApprovalRequest, decision } as unknown as Block)
  const failed = (id: string, command: string, output: string): Block => ({ kind: 'tool', id: `tool:${id}`, turnId: 'turn', at, seq: ++seq, origin: { kind: 'root' }, call: { id, name: 'Bash', input: { command } }, stream: '', output, isError: true, complete: true } as Block)
  return [
    resolved('kybern_request_login', LOGIN, { decision: 'submit', response: { status: 'signed_in', cli: 'gh', service: 'GitHub', account: 'Tresnanda' } }),
    resolved('kybern_request_login', LOGIN, { decision: 'submit', response: { status: 'already_signed_in', cli: 'gh', account: 'Tresnanda' } }),
    failed('gh-fail', 'gh pr create --fill', 'To get started with GitHub CLI, please run:  gh auth login'),
    failed('vercel-fail', 'vercel deploy --prebuilt', 'Error: No existing credentials found. Please run `vercel login`'),
    resolved('kybern_askpass', SUDO, { decision: 'submit', response: { secret: '[redacted]' } }),
    resolved('kybern_askpass', { ...SUDO, command: 'git push' }, { decision: 'deny' }),
    resolved('kybern_askpass', { ...SUDO, purpose: 'ssh_host_key', confirm: true, host: '203.0.113.24', key_type: 'ED25519' }, { decision: 'submit', response: { confirmed: true } }),
    resolved('kybern_askpass', { ...SUDO, purpose: 'ssh_passphrase', command: 'git push' }, { decision: 'deny', reason: 'timed out' }),
    resolved('kybern_request_permission', PERMISSION, { decision: 'submit', response: { status: 'granted', pane: 'camera', app: 'Anamorphia' } }),
    resolved('AskUserQuestion', QUESTION, { decision: 'submit', response: { answers: { 'Where should the tab strip sit?': 'In a 32 px row' }, auto: { at: '2026-10-23T02:00:00+08:00', waited_seconds: 600 } } }),
  ]
}

const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(req, s) { if (s.upgrade(req)) return; return new Response('fixture') }, websocket: { message(ws, raw) {
  const request = JSON.parse(String(raw)); let result: unknown = {}; const params = request.params ?? {}
  switch (request.method) {
    case 'daemon.info': result = { protocol_version: PROTOCOL_VERSION, environment_id: 'summoned-fixture', version: 'fixture' }; break
    case 'projects.list': result = { projects: [] }; break
    case 'threads.list': result = { threads: [thread()] }; break
    case 'threads.messages.list': result = { messages: [] }; break
    case 'threads.target.get': result = { target: { provider: thread().provider }, pending_permission_mode: null, quota_limited: false }; break
    case 'tasks.list': result = { tasks: [] }; break
    case 'events.subscribe': result = { subscription_id: 'fixture', head_seq: 0, replay_ready: true }; break
    case 'requests.progress': result = { items: [] }; break
    case 'requests.act': acted = `${params.action}${params.value ? `:${params.value}` : ''}`; break
    case 'approvals.respond': responded = `${params.decision}`; break
    case 'queue.add': queued = params.message?.parts?.[0]?.text ?? ''; break
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
setSettings({ ask_deadlines: { enabled: true, max_seconds: 900 } } as unknown as Settings)

const MODES = ['login-ask', 'login-wait', 'login-terminal', 'login-paste', 'login-done', 'login-failed', 'password-sudo', 'password-wrong', 'password-passphrase', 'password-hostkey', 'password-git-user', 'password-git-pass', 'permission-ask', 'permission-wait', 'permission-done', 'permission-off', 'permission-fda', 'deadline', 'deadline-paused', 'deadline-last', 'records', 'settings']
const FORMS = new Set(['login-paste', 'password-sudo', 'password-wrong', 'password-passphrase', 'password-hostkey', 'password-git-user', 'password-git-pass', 'deadline', 'deadline-paused', 'deadline-last'])

function show(next: string) {
  forgetProgress(`approval-${sequence}`)
  mode = next; sequence++; responded = ''; acted = ''; queued = ''
  const th = thread(), c = card()
  if (c?.progress) applyProgress({ approval_id: c.approval.id, thread_id: th.id, kind: 'login', phase: 'asking', updated_at: new Date().toISOString(), ...c.progress } as RequestProgress, { openTerminal: false })
  set({ selectedId: th.id, threads: [th], open: { ...emptyThreadState(), thread: th, loaded: true, pendingApprovals: c ? [c.approval] : [] } })
}
show(mode)

function Records() {
  const blocks = recordBlocks()
  const ctx: RowContext = { threadId: thread().id, tasksByToolCall: new Map(), childrenByParent: new Map(), children: [], signIn: signInRows(blocks) }
  return <div testId="records-fixture" style={{ display: 'flex', flexDirection: 'column', paddingLeft: 24, paddingRight: 24 }}><WorkRows blocks={blocks} ctx={ctx} /></div>
}

function Fixture() {
  useApp((s) => s.statusDetail)
  const t = useTheme(), [selected, choose] = useState(mode)
  const active = useApp((s) => s.open.thread)!
  return <div testId="fixture-ready" style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', position: 'relative', backgroundColor: WALLPAPER ? 'rgba(0, 0, 0, 0)' : t.surface }}>
    {WALLPAPER && <img src={WALLPAPER} alt="" objectFit="cover" style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%' }} />}
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: 14 }}>{MODES.map((name) => <Button key={name} size="sm" testId={`fixture-${name}`} variant={selected === name ? 'secondary' : 'ghost'} onClick={() => { choose(name); show(name) }}>{name}</Button>)}</div>
    <div style={{ flexGrow: 1 }} />
    {responded && <div testId={`responded-${responded}`} style={{ width: 1, height: 1 }} />}
    {acted && <div testId={`acted-${acted}`} style={{ width: 1, height: 1 }} />}
    {queued && <div testId="queued" style={{ width: 1, height: 1 }} />}
    <div style={{ display: 'flex', flexDirection: 'column', width: 700, alignSelf: 'center', paddingBottom: 24 }}>
      {selected === 'records' ? <Records /> : selected === 'settings' ? <AskDeadlineSection /> : <ThreadRequests />}
      {!FORMS.has(selected) && selected !== 'records' && selected !== 'settings' && <ComposerView draftKey="fixture" currentThreadId={active.id} provider={active.provider} providers={[]} accounts={[]} mode="supervised" onModeChange={() => {}} catalogLoading={false} onReloadModels={async () => {}} onSend={async () => {}} />}
      <Label color={t.textTertiary} size={10}>Native fixture · all actions stay in memory</Label>
    </div>
  </div>
}
render(<ThemeProvider><Fixture /></ThemeProvider>, { title: 'Summoned cards', width: 1024, height: 820, focus: false, onKeyDown: onWindowKeyDown })
process.stdin.on('end', () => { server.stop(true); process.exit(0) })
process.stdin.on('close', () => { server.stop(true); process.exit(0) })
void getState
