// Deterministic native fixture for "Add to another machine": the sheet (form, folder chooser, progress, done), the agent
// card and its transcript records. No real daemon or machine is touched: an in-process socket answers every call.
// Drive it with `provision.shots.ts`.
import '../native/local-build.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { render } from '@gpuix/react'
import { useState } from 'react'
import { PROTOCOL_VERSION, type ApprovalRequest, type ProvisionPlan, type ProvisionStatus, type Thread } from '../../../../packages/kybern-client/src/types.ts'
import { emptyThreadState, type Block } from '../../../../packages/kybern-client/src/transcript.ts'
import { connect, set, useApp } from '../state.ts'
import type { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
import { ThemeProvider, useTheme, Label } from '../ui.tsx'
import { Button } from '../kit/Button.tsx'
import { ThreadRequests } from '../transcript/Requests.tsx'
import { WorkRows, type RowContext } from '../transcript/rows.tsx'
import { onWindowKeyDown } from '../nav/keys.ts'
import { ProvisionSheet } from './ProvisionSheet.tsx'
import { setProvisionFixture } from './targets.ts'

const at = '2026-10-29T10:00:00+08:00'
const HOME = '/home/tresnanda'
const PLAN: ProvisionPlan = {
  project_id: 'p-kybern', project_name: 'kybern', kind: 'single',
  source: { id: 'win', name: 'Windows PC', os: 'windows', online: true },
  target: { id: 'kdi', name: 'os-kdi', os: 'linux', online: true },
  repos: [{ path: '.', remote: 'github.com/tresnanda/kybern', branch: 'feat/machines-network' }],
  suggested_path: `${HOME}/projects/kybern`, target_home: HOME,
  path_check: { state: 'free', path: `${HOME}/projects/kybern`, message: 'New folder · it will be created' },
  env_files: [{ path: '.env', size: 412, selected: true }, { path: 'apps/mobile/.env.local', size: 1830, selected: true }, { path: 'crates/kybern-daemon/.envrc', size: 96, selected: true }],
}
if (process.env.PROVISION_PARTIAL === '1') {
  PLAN.kind = 'group'
  PLAN.repos = ['web', 'api', 'worker'].map((path) => ({ path, branch: 'main' }))
  PLAN.members = PLAN.repos.map((repo, index) => ({ path: repo.path, target_path: repo.path, present: index === 0 }))
  PLAN.path_check = { state: 'same_repo', path: PLAN.suggested_path!, message: 'Has 1 of 3 repos · only the missing repos will be added' }
  PLAN.env_files = [{ path: 'api/.env', size: 412, selected: true }]
}
let mode = 'sheet'
let sequence = 0
const thread = (): Thread => ({ id: 'thread-provision', project_id: 'p-kybern', title: 'Fix the flaky clock test', provider: { kind: 'claude_code', instance: 'default' }, model: null, effort: null, permission_mode: 'auto', status: 'awaiting_approval', worktree: null, cwd: 'D:\\code\\kybern', provider_session_id: null, pinned: false, created_at: at, updated_at: at, last_seq: 1 } as unknown as Thread)
const status = (phase: ProvisionStatus['phase']): ProvisionStatus => ({
  operation_id: 'op', item_id: 'item', project_id: 'p-kybern', project_name: 'kybern', target: 'kdi', target_name: 'os-kdi', path: `${HOME}/projects/kybern`, phase,
  detail: phase === 'sending' ? 'Sending the repository to os-kdi' : phase === 'cloning' ? 'os-kdi is cloning the repository from github.com/tresnanda/kybern' : null,
  bytes_sent: 61_400_000, bytes_total: 148_200_000, updated_at: at,
  ...(phase === 'done' ? { result: { project: { id: 'p-kdi', name: 'kybern', path: `${HOME}/projects/kybern` }, env_written: ['.env', 'apps/mobile/.env.local', 'crates/kybern-daemon/.envrc'], env_kept: [], cloned_from_remote: true } } : {}),
} as ProvisionStatus)
const FOLDERS: Record<string, string[]> = { [HOME]: ['code', 'Downloads', 'projects', 'snap'], [`${HOME}/projects`]: ['ade-network-test', 'beme', 'gallery', 'zeron'] }
const cardApproval = (): ApprovalRequest => ({ id: `approval-${sequence}`, thread_id: thread().id, turn_id: 'turn', tool_call_id: 'call', created_at: at, suggestions: [], summary: 'Add kybern to os-kdi', tool_name: 'kybern_project_provision',
  input: { operation_id: 'op', then: 'delegate', plan: PLAN } } as unknown as ApprovalRequest)

/** What the source and target machines answer, in memory. */
function answer(method: string, params: Record<string, unknown>): unknown {
  switch (method) {
    case 'projects.provision_plan': {
      const asked = params.path as string | undefined
      if (!asked || asked.replace(/^~/, HOME) === PLAN.suggested_path) return PLAN
      return { ...PLAN, path_check: asked.endsWith('/gallery') ? { state: 'not_empty', path: asked, message: 'This folder already holds other files. Choose an empty or new folder.' } : { state: 'free', path: asked, message: 'New folder · it will be created' } }
    }
    case 'projects.browse': { const p = ((params.path as string) || HOME).replace(/^~/, HOME); const dirs = FOLDERS[p] ?? []; return { path: p, parent: p === '/' ? null : path.dirname(p), directories: dirs.map((name) => ({ name, path: `${p}/${name}` })), has_more: false } }
    case 'projects.provision': return status(mode === 'sheet-done' ? 'done' : 'sending')
  }
  return {}
}
const fake = { call: (method: string, params: Record<string, unknown>) => new Promise((resolve) => setTimeout(() => resolve(answer(method, params ?? {})), 60)), onNotification: () => () => {} } as unknown as KybernClient
const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(req, s) { if (s.upgrade(req)) return; return new Response('fixture') }, websocket: { message(ws, raw) {
  const request = JSON.parse(String(raw)); let result: unknown = {}; const params = request.params ?? {}
  switch (request.method) {
    case 'daemon.info': result = { protocol_version: PROTOCOL_VERSION, environment_id: 'provision-fixture', version: 'fixture' }; break
    case 'projects.list': result = { projects: [] }; break
    case 'threads.list': result = { threads: [thread()] }; break
    case 'threads.messages.list': result = { messages: [] }; break
    case 'threads.target.get': result = { target: { provider: thread().provider }, pending_permission_mode: null, quota_limited: false }; break
    case 'tasks.list': result = { tasks: [] }; break
    case 'events.subscribe': result = { subscription_id: 'fixture', head_seq: 0, replay_ready: true }; break
    case 'requests.progress': result = { items: [] }; break
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
setProvisionFixture({
  client: () => fake,
  context: {
    name: 'kybern', source: 'win',
    instances: [{ machineId: 'win', machineName: 'Windows PC', projectId: 'p-kybern', online: true }, { machineId: 'mac', machineName: 'MacBook', projectId: 'p-mac', online: true }],
    targets: [
      { machineId: 'kdi', machineName: 'os-kdi', online: true, has: false },
      { machineId: 'vps', machineName: 'treshnandavps', online: false, has: false },
      { machineId: 'mac', machineName: 'MacBook', online: true, has: true },
    ],
  },
})

const MODES = ['sheet', 'sheet-chooser', 'sheet-taken', 'sheet-progress', 'sheet-done', 'card', 'records']
function recordBlocks(): Block[] {
  const input = { operation_id: 'op', then: 'delegate', plan: PLAN }
  const resolved = (n: number, decision: unknown): Block => ({ kind: 'approval', id: `rec-${n}`, turnId: 'turn', at, seq: n, approval: { id: `rec-${n}`, thread_id: thread().id, turn_id: 'turn', tool_name: 'kybern_project_provision', input, summary: '', suggestions: [], created_at: at } as unknown as ApprovalRequest, decision } as unknown as Block)
  return [resolved(1, { decision: 'submit', response: { path: `${HOME}/projects/kybern`, env_files: ['.env'] } }), resolved(2, { decision: 'deny' })]
}
function show(next: string) {
  mode = next; sequence++
  const th = thread()
  set({ selectedId: th.id, threads: [th], open: { ...emptyThreadState(), thread: th, loaded: true, pendingApprovals: next === 'card' ? [cardApproval()] : [] } })
}
show(mode)

function Fixture() {
  useApp((s) => s.statusDetail)
  const t = useTheme(), [selected, choose] = useState(mode)
  const sheet = selected.startsWith('sheet')
  return <div testId="fixture-ready" style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', position: 'relative', backgroundColor: t.surface }}>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: 14 }}>{MODES.map((name) => <Button key={name} size="sm" testId={`fixture-${name}`} variant={selected === name ? 'secondary' : 'ghost'} onClick={() => { choose(name); show(name) }}>{name}</Button>)}</div>
    {sheet && <ProvisionSheet key={`${selected}:${sequence}`} inline projectId="p-kybern" machineId="win" close={() => {}} />}
    <div style={{ flexGrow: 1 }} />
    <div style={{ display: 'flex', flexDirection: 'column', width: 700, alignSelf: 'center', paddingBottom: 24 }}>
      {selected === 'records' ? <div style={{ display: 'flex', flexDirection: 'column', paddingLeft: 24, paddingRight: 24 }}><WorkRows blocks={recordBlocks()} ctx={{ threadId: thread().id, tasksByToolCall: new Map(), childrenByParent: new Map(), children: [], signIn: [] } as unknown as RowContext} /></div> : <ThreadRequests />}
      <Label color={t.textTertiary} size={10}>Native fixture · all actions stay in memory</Label>
    </div>
  </div>
}
render(<ThemeProvider><Fixture /></ThemeProvider>, { title: 'Add to another machine', width: 1024, height: 860, focus: false, onKeyDown: onWindowKeyDown })
process.stdin.on('end', () => { server.stop(true); process.exit(0) })
process.stdin.on('close', () => { server.stop(true); process.exit(0) })
