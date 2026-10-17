/** Visual RPC boundary: mocked settings/provider/GitHub reads, otherwise the scratch daemon. */
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import type { KybernClient } from '../../../packages/kybern-client/src/client.ts'
import type { SeedContext } from './load.ts'
import { SCRATCH, readState, writeState, connect } from './fixture.ts'
import { settings9aMock } from './mock.settings9a.ts'

export async function seed(client: KybernClient, { state, scratch, projects }: SeedContext) {
  const thread = await client.call('threads.create', { project_id: projects[0]!.id, provider: { kind: 'codex', instance: 'default' }, title: 'Visual worktree', use_worktree: true })
  writeFileSync(path.join(scratch, 'settings-fixture.json'), JSON.stringify({ projectId: projects[0]?.id, threadId: thread.id }))
}
export async function ids(_client: KybernClient) {
  const state = readState()!
  const upstreamPort = state.daemonPort ?? state.port
  const ready = path.join(SCRATCH, 'settings-proxy.json')
  const fixture = JSON.parse(readFileSync(path.join(SCRATCH, 'settings-fixture.json'), 'utf8'))
  rmSync(ready, { force: true })
  const child = spawn('bun', [import.meta.filename, '--proxy', JSON.stringify({ port: upstreamPort, token: state.token, ready, ...fixture })], { stdio: 'ignore' })
  child.unref()
  process.once('exit', () => { child.kill(); writeState({ ...state, port: upstreamPort, daemonPort: upstreamPort, proxyPid: undefined }) })
  for (let i = 0; i < 100 && !existsSync(ready); i++) await Bun.sleep(50)
  if (!existsSync(ready)) throw Error('Settings visual proxy did not start')
  const { port } = JSON.parse(readFileSync(ready, 'utf8'))
  writeState({ ...state, port, daemonPort: upstreamPort, proxyPid: child.pid })
  process.env.KYBERN_URL = `ws://127.0.0.1:${port}/ws`
  process.env.KYBERN_TOKEN = state.token
  const boundary = await connect({ ...state, port })
  try { return await boundary.call('visual.settings' as never, {} as never) as Record<string, unknown> } finally { boundary.close() }
}

if (import.meta.main && process.argv[2] === '--proxy') {
  const config = JSON.parse(process.argv[3]!)
  const { actionFixture } = await import('../src/pulls/verify.fixture.ts')
  const fixture = actionFixture()
  const providers = [{ kind: 'codex', display_name: 'Codex', available: true, binary_path: '/fixture/bin/codex', version: '1.0.0', models: [{id:'gpt-6.1-sol',display_name:'GPT-6.1 Sol',is_default:true,efforts:['low','medium','high'],default_effort:'medium'}], supports_effort_switch:true, supported_efforts:['low','medium','high'], supported_permission_modes: ['supervised', 'auto', 'full-access'], supports_fork: true, supports_model_switch: true, instances: ['work'] }]
  const mocks: Record<string, unknown> = {
    'access.pairing.create': { code: '123456', expires_at: new Date(Date.now() + 5 * 60_000).toISOString(), endpoints: [] },
    'access.tokens.list': { tokens: [] },
    'access.exposure.get': { tailscale: false, tailscale_ip: null },
    'providers.list': { providers },
    'providers.accounts.catalog': providers[0],
    'queue.list': { messages: [] },
    'projects.browse': { path: '/fixture/projects', parent: '/fixture', directories: [{ name: 'app', path: '/fixture/projects/app' }, { name: 'docs', path: '/fixture/projects/docs' }], has_more: false },
    'threads.messages.list': { messages: [] },
    'threads.target.get': { target: { provider: {kind:'codex',instance:'work'}, model:null, effort:null }, account_override:false, effective_permission_mode:'supervised' },
    'threads.checkpoints': { checkpoints: [] },
    'tasks.list': { tasks: [] },
    'threads.runtime_tasks': { tasks: [] },
    'approvals.list': { approvals: [] },
    'skills.list': { skills: [] },
    'providers.accounts.list': { accounts: [{ provider: { kind: 'codex', instance: 'work' }, name: 'Work', color: 'blue', status: 'signed_in', is_default: true, projects: [], identity: { email: 'fixture@example.test' } }] },
    'harness_updates.list': { updates: [] },
    'daemon_update.status': { status: 'not_checked', current_version: '0.9.1', message: '' },
    'cursor.status': { sdk_version: 'fixture', installed: false, installing: false, signing_in: false, account: 'signed_out' },
    'computer.status': { supported: true, installed: false, enabled: true, signed: false, ready: false, required_version: '1', accessibility: 'unknown', screen_recording: 'unknown', checks: [] },
    'computer.notes.list': { notes: [] },
    'integrations.list': { items: [], warnings: [] },
    'daemon.activity': { live_sessions: 0, idle_sessions: 0, terminals: 0, connections: 1 },
    'usage.limits': { providers: [], accounts: [], refreshing: [] },
  }
  let mode = ''
  const timestamp = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
  const stabilize = (value: any): any => Array.isArray(value) ? value.map(stabilize) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, v]) => [key, key === 'created_at' || key === 'updated_at' ? timestamp : key === 'is_draft' && mode === 'draft' ? true : stabilize(v)])) : value
  const server = Bun.serve<{ real: WebSocket; fake: WebSocket; queued: [WebSocket, string][] }>({
    hostname: '127.0.0.1', port: 0,
    async fetch(req, s) {
      const url = new URL(req.url)
      if (url.pathname === '/mode') { mode = url.searchParams.get('value') ?? ''; fixture.empty(mode === 'empty'); fixture.problem(mode === 'error' ? 'auth' : null); return new Response('ok') }
      if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
        const target = new URL(req.url); target.port = String(config.port)
        return fetch(new Request(target, req))
      }
      const real = new WebSocket(`ws://127.0.0.1:${config.port}/ws`, { headers: { origin: 'tauri://localhost', Authorization: `Bearer ${config.token}` } } as never)
      const fake = new WebSocket(fixture.env.KYBERN_URL)
      if (s.upgrade(req, { data: { real, fake, queued: [] } })) return
      real.close(); fake.close(); return new Response('Not found', { status: 404 })
    },
    websocket: {
      open(ws) {
        for (const upstream of [ws.data.real, ws.data.fake]) {
          upstream.onmessage = e => ws.send(upstream === ws.data.fake ? JSON.stringify(stabilize(JSON.parse(String(e.data)))) : String(e.data))
          upstream.onopen = () => { for (const [socket, data] of ws.data.queued) if (socket === upstream) socket.send(data); ws.data.queued = ws.data.queued.filter(([socket]) => socket !== upstream) }
        }
      },
      message(ws, raw) {
        const text = String(raw), req = JSON.parse(text)
        const reply = (result: unknown) => ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }))
        if (req.method === 'github.pr.list' && req.params?.project_id !== config.projectId) { reply({ pull_requests: [] }); return }
        { const mocked = settings9aMock(req.method, mode, req.params); if (mocked !== undefined) { reply(mocked); return } }
        if (req.method === 'visual.settings') { reply({ port: server.port, threadId: config.threadId }); return }
        // settings9 environment screens: paired devices and a running Tailscale listener.
        if (req.method === 'access.tokens.list' && mode === 'devices') { reply({ tokens: [{ id: 'dev-1', label: 'Pixel tablet', created_at: timestamp, last_used_at: timestamp, revoked: false, scopes: [] }, { id: 'dev-2', label: 'Kybern mobile · iPhone', created_at: timestamp, last_used_at: timestamp, revoked: false, scopes: [] }, { id: 'dev-3', label: 'Old laptop', created_at: timestamp, last_used_at: timestamp, revoked: true, scopes: [] }, { id: 'dev-0', label: 'bootstrap', created_at: timestamp, last_used_at: timestamp, revoked: false, scopes: [] }] }); return }
        if (req.method === 'access.exposure.get' && mode === 'devices') { reply({ tailscale: true, tailscale_ip: '100.64.0.7' }); return }
        if (req.method in mocks) { reply(mocks[req.method]); return }
        if (req.method === 'usage.summary' && mode === 'usage-empty') { reply({ rows: [], total: { key: 'total', turns: 0, usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }, cost_usd: 0 } }); return }
        let socket: WebSocket
        if (req.method.startsWith('github.') || req.method === 'usage.summary') socket = ws.data.fake
        else socket = ws.data.real
        if (socket.readyState === WebSocket.OPEN) socket.send(text); else ws.data.queued.push([socket, text])
      },
      close(ws) { ws.data.real.close(); ws.data.fake.close() },
    },
  })
  writeFileSync(config.ready, JSON.stringify({ port: server.port }))
  process.once('SIGTERM', () => { fixture.close(); server.stop(true); process.exit(0) })
}
