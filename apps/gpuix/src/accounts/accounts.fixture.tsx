// "Accounts across machines" on made-up machines: the real app (`main.tsx`) against a loopback fixture daemon per
// machine, with a thread at its usage limit. fedora lends Claude Code and kdi-vps Codex (`login.broker.per_kind.v1`),
// studio is offline and pi-box runs a Kybern too old to list accounts. Run by `accounts.shots.ts`; every file and credential stays in its scratch
// directory. `ACCOUNTS_DEMO_OFFER=clash` opens on the changed-default card instead of the new-machine one, and
// `ACCOUNTS_DEMO_AWAY=1` shows the thread with its account unavailable instead of at its limit, and
// `ACCOUNTS_DEMO_DELEGATED=1` a turn that delegated to agents on the default and on another account.
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { PROTOCOL_VERSION, type AccountSummary, type MachineCard, type NetworkStatus, type ProviderKind, type ProviderLimits, type ProviderStatus } from '../../../../packages/kybern-client/src/types.ts'
import { writeMachineRecords } from '../machines/store.ts'
import { writeCredential } from '../environments/credentials.ts'

for (const key of ['KYBERN_DATA_DIR', 'KYBERN_CLIENT_CONFIG_DIR', 'KYBERN_GPUIX_CREDENTIALS_DIR']) {
  if (!process.env[key]) throw Error(`Accounts fixture requires ${key}`)
}

const AWAY = process.env.ACCOUNTS_DEMO_AWAY === '1'
const DELEGATED = process.env.ACCOUNTS_DEMO_DELEGATED === '1'
const ids = ['mac', 'fedora', 'satya', 'vps', 'studio', 'old'] as const
type Id = typeof ids[number]
const NAMES: Record<Id, string> = { mac: 'MacBook Pro', fedora: 'fedora', satya: 'SatyaMas', vps: 'kdi-vps', studio: 'studio', old: 'pi-box' }
const FEATURES = ['network.v1', 'login.broker.v1', 'login.broker.choice.v1', 'login.broker.per_kind.v1', 'accounts.shared.v1', 'accounts.login.handoff.v1', 'accounts.write.v1', 'antigravity.accounts.v1']
/** pi-box: a Kybern from before accounts could be listed. */
const OLD_FEATURES = ['network.v1']
const featuresOf = (id: Id) => (id === 'old' ? OLD_FEATURES : FEATURES)
const now = Date.now()
const at = new Date(now).toISOString()
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString()
const reset = (minutes: number) => Math.round(now / 1000 + minutes * 60)

const keys = ids.map(() => generateKeyPairSync('ed25519'))
const cards = ids.map((machine_id, i): MachineCard => ({
  machine_id, name: NAMES[machine_id], os: machine_id === 'mac' ? 'darwin' : machine_id === 'satya' ? 'windows' : 'linux',
  is_self: machine_id === 'mac', status: machine_id === 'studio' ? 'offline' : 'online', features: featuresOf(machine_id), online_ratio_7d: machine_id === 'fedora' ? 0.99 : 0.4,
  signing_key: keys[i]!.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'),
} as MachineCard))

// ── Accounts ─────────────────────────────────────────────────────────────────

const account = (kind: ProviderKind, instance: string, name: string, email: string | null, patch: Partial<AccountSummary> = {}): AccountSummary => ({
  provider: { kind, instance }, name, status: email ? 'signed_in' : 'signed_out', is_default: false, projects: [], managed: instance !== 'default', can_sign_out: instance !== 'default',
  terminal: instance === 'default', ...(email ? { identity: { email }, key: `${kind}:${email}` } : {}), ...patch,
})
const accounts: Record<Id, AccountSummary[]> = {
  mac: [
    account('claude-code', 'default', 'CLI account', 'sam@hey.example', { identity: { email: 'sam@hey.example', plan: 'Max' } }),
    account('claude-code', 'work', 'Work', 'sam@acme.example', { identity: { email: 'sam@acme.example', plan: 'Team' }, color: 'blue', is_default: true }),
    account('codex', 'default', 'CLI account', 'sam@hey.example', { identity: { email: 'sam@hey.example', plan: 'Plus' }, is_default: true }),
    account('antigravity', 'default', 'CLI account', 'sam@hey.example', { is_default: true }),
  ],
  fedora: [
    // fedora's shell was signed out of Personal (its chip says so); SatyaMas's was never signed in (one line under the agent).
    account('claude-code', 'default', 'CLI account', 'sam@hey.example', { status: 'signed_out' }),
    account('claude-code', 'w2', 'Work', 'sam@acme.example', { identity: { email: 'sam@acme.example', plan: 'Team' }, color: 'blue', is_default: true }),
    account('codex', 'default', 'CLI account', 'sam@hey.example', { is_default: true }),
  ],
  satya: [
    account('claude-code', 'default', 'CLI account', null, { is_default: true }),
    account('claude-code', 'b1', 'Work', 'sam@acme.example', { identity: { email: 'sam@acme.example' }, color: 'blue', broker: { machine_id: 'fedora', machine_name: 'fedora', broker_account: 'w2', state: 'borrowing' } }),
    account('codex', 'default', 'CLI account', null, { is_default: true }),
  ],
  // kdi-vps lends Codex; nothing of Claude Code is signed in there.
  vps: [
    account('codex', 'default', 'CLI account', 'sam@hey.example', { identity: { email: 'sam@hey.example', plan: 'Plus' }, is_default: true }),
  ],
  studio: [],
  old: [],
}

const limits = (provider: ProviderKind, five: number, week: number, instance?: string, updated = ago(1)): ProviderLimits => ({
  provider, updated_at: updated, source: 'live', ...(instance ? { instance } : {}),
  limits: [{ name: 'five_hour', used_percent: five, window_minutes: 300, resets_at: reset(138) }, { name: 'weekly', used_percent: week, window_minutes: 10080, resets_at: reset(60 * 70) }],
})
const usage = (id: Id) => {
  if (id === 'mac') return { providers: [limits('claude-code', 100, 46), limits('codex', 34, 12)], accounts: [limits('claude-code', 22, 51, 'default'), limits('claude-code', 100, 46, 'work'), limits('codex', 34, 12, 'default')] }
  if (id === 'fedora') return { providers: [limits('claude-code', 100, 46, undefined, ago(9))], accounts: [limits('claude-code', 100, 46, 'w2', ago(9))] }
  return { providers: [], accounts: [] }
}

const provider = (kind: ProviderKind, display_name: string, available: boolean): ProviderStatus => ({ kind, display_name, available, supported_permission_modes: ['supervised', 'full-access'], supports_fork: true, supports_model_switch: true, models: [{ id: 'default', display_name: 'Default', is_default: true }, { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' }], instances: ['default'] })
const providers = (id: Id) => [
  provider('claude-code', 'Claude Code', true), provider('codex', 'Codex', true), provider('antigravity', 'Antigravity', id === 'mac'), provider('cursor', 'Cursor', false), provider('omp', 'omp', false),
]

// ── Settings and offers ──────────────────────────────────────────────────────

let settings: Record<string, unknown> = {
  default_provider: 'claude-code', default_permission_mode: 'supervised', worktrees_default: false, generate_titles: true, notifications: false,
  auto_update_harnesses: false, check_harness_versions: false, auto_update_daemon: false,
  providers: { 'claude-code': { accounts: { work: { name: 'Work', directory: '/fixture/work', color: 'blue', email: 'sam@acme.example' } }, default_account: 'work', env: {} } },
  background: { session_idle_minutes: 10, max_idle_sessions: 4, terminal_idle_minutes: 60, daemon_idle_exit_minutes: 0, save_power_on_battery: false },
  access: { tailscale: false }, computer_use: { enabled: false, foreground: 'ask', show_cursor: false },
  orchestration: { max_active_children: 4, lead_max_children: 6, max_depth: 2, lead_autonomy: 'propose_large', lead_workspace: 'shared', lead_push_without_asking: false, rotation_budget_tokens: 200000 },
  tell_agents_about_kybern: true,
  accounts_shared: { profiles: { 'claude-code:sam@hey.example': { name: 'Personal', color: 'green' } }, defaults: { 'claude-code': 'claude-code:sam@acme.example' } },
}
const offers = () => [
  ...(process.env.ACCOUNTS_DEMO_OFFER === 'clash' ? [{ id: 'clash:claude-code:fedora', kind: 'migration_clash', fingerprint: 'x', machine_id: 'fedora', machine_name: 'fedora', keys: [], machines: [], clash: { kind: 'claude-code', machine_id: 'fedora', was: 'claude-code:sam@hey.example', now: 'claude-code:sam@acme.example' } }] : []),
  { id: 'new_machine:satya', kind: 'new_machine', fingerprint: 'claude-code:sam@hey.example,codex:sam@hey.example', machine_id: 'satya', machine_name: 'SatyaMas', keys: ['claude-code:sam@hey.example', 'codex:sam@hey.example'], machines: ['mac', 'fedora'] },
]

// ── The thread at its limit ──────────────────────────────────────────────────

const project = { id: 'fixture-project', name: 'acme-web', path: '/fixture/acme-web', is_git: true, brief_in_all_threads: false, created_at: ago(600), updated_at: ago(1) }
const thread = {
  id: 'fixture-thread', project_id: project.id, title: 'Fix the checkout totals', provider: { kind: 'claude-code', instance: 'work' }, permission_mode: 'supervised', status: 'idle',
  cwd: project.path, pinned: false, created_at: ago(30), updated_at: ago(1), last_seq: 8,

}
const transcript = [
  { role: 'user', id: 'u1', turn_id: 't1', seq: 1, at: ago(12), message: { parts: [{ type: 'text', text: 'The checkout total is off by the shipping fee when a coupon is applied. Fix it and add a test.' }] } },
  { role: 'notice', turn_id: 't1', seq: 2, at: ago(11), level: 'info', text: 'Switched to Work', data: { kind: 'account_switched', from: { kind: 'claude-code', instance: 'default' }, to: { kind: 'claude-code', instance: 'work' }, reason: 'limit' } },
  { role: 'assistant', id: 'a1', turn_id: 't1', seq: 3, at: ago(10), origin: { kind: 'root' }, text: 'The coupon was subtracted after shipping was added, so a percentage coupon discounted the fee too. I moved the discount before shipping in `cart/totals.ts` and added a test for both coupon kinds.', complete: true },
  { role: 'turn_summary', turn_id: 't1', seq: 5, at: ago(3), stop_reason: 'end_turn', usage: { input_tokens: 1200, output_tokens: 600, cache_read_tokens: 0, cache_write_tokens: 0 }, duration_ms: 480000, terminal_message_id: 'a1' },
  { role: 'notice', turn_id: 't1', seq: 4, at: ago(2), level: 'info', text: `Waiting for Work’s limit to reset at ${new Date(now + 138 * 60_000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`, data: { kind: 'account_wait', until: new Date(now + 138 * 60_000).toISOString(), account: { kind: 'claude-code', instance: 'work' } } },
]

// ── Delegated agents: one on the default account, one on another, one on another machine ─────────────────────────────

const delegates = [
  { id: 'child-default', machine: 'mac' as Id, instance: 'work', title: 'Review the totals change' },
  { id: 'child-other', machine: 'mac' as Id, instance: 'default', title: 'Add coupon edge cases' },
  { id: 'child-remote', machine: 'fedora' as Id, instance: 'default', title: 'Run the suite on Linux' },
]
const childThread = (child: typeof delegates[number], n: number) => ({
  ...thread, id: child.id, title: child.title, model: 'claude-opus-5-5',
  // A child on its parent's machine lists under it; one on another machine lists there, with the thread it came from.
  ...(child.machine === 'mac' ? { parent_thread_id: thread.id } : { origin: { machine_id: 'mac', machine_name: NAMES.mac, thread_id: thread.id, operation_id: `op-${n}`, kind: 'delegation', permission_cap: 'supervised' } }),
  // fedora's terminal login is Personal for this run, so the remote child is on another account too.
  provider: { kind: 'claude-code', instance: child.instance },
  delegation: { task_id: `task-${n}`, operation_id: `op-${n}`, parent_thread_id: thread.id, depth: 1, role: 'implementation', workspace: 'worktree', status: 'completed', worktree_state: 'active', started_at: ago(8), completed_at: ago(5) },
})
const delegateCalls = delegates.map((child, n) => ({
  role: 'tool_call', turn_id: 't1', seq: 2 + n / 10, at: ago(9), origin: { kind: 'root' }, is_error: false, complete: true,
  call: { id: `call-${n}`, name: 'kybern_agent_delegate', input: { title: child.title, provider: 'claude-code', model: 'claude-opus-5-5', workspace: 'worktree' } },
  output: { task_id: `task-${n}`, thread_id: child.id, title: child.title, provider: 'claude-code', model: 'claude-opus-5-5', workspace: 'worktree', status: 'completed', ...(child.machine === 'mac' ? {} : { machine: { id: child.machine, name: NAMES[child.machine] } }) },
}))
if (DELEGATED) accounts.fedora[0] = account('claude-code', 'default', 'CLI account', 'sam@hey.example')
const shownTranscript = () => DELEGATED ? [transcript[0]!, ...delegateCalls, ...transcript.slice(1).filter((entry) => entry.role !== 'notice')] : AWAY ? transcript.filter((entry) => entry.role !== 'notice') : transcript
const childrenOn = (id: Id) => (DELEGATED ? delegates.flatMap((child, n) => (child.machine === id ? [childThread(child, n)] : [])) : [])

// ── The daemons ──────────────────────────────────────────────────────────────

const network = (id: Id): NetworkStatus => ({ enabled: true, configured: true, removed: false, network_id: 'fixture', self_machine: cards.find((c) => c.machine_id === id)!, members: cards.map((c) => ({ ...c, is_self: c.machine_id === id })), found: [], broker: null, outbox: { queued: 0, failed: 0 }, tailscale: { installed: true, running: true } } as unknown as NetworkStatus)

const server = Bun.serve<{ id: Id }>({ port: 0, hostname: '127.0.0.1', fetch(req, s) {
  const url = new URL(req.url)
  const id = (url.pathname.split('/')[1] || 'mac') as Id
  // studio is away: nothing answers there.
  if (id === 'studio') return new Response('Offline', { status: 503 })
  if (url.pathname.endsWith('/ws') && s.upgrade(req, { data: { id } })) return
  const index = ids.indexOf(id)
  if (index >= 0 && url.pathname.endsWith('/.well-known/kybern/machine')) {
    const stamp = new Date().toISOString(), nonce = url.searchParams.get('nonce') ?? ''
    const message = Buffer.from(`kybern-wk-v1\0${nonce}${id}${stamp}${url.host}`)
    return Response.json({ machine_id: id, name: NAMES[id], os: cards[index]!.os, signing_key: cards[index]!.signing_key, at: stamp, proof: sign(null, message, keys[index]!.privateKey).toString('base64') })
  }
  return new Response('Accounts fixture', { status: 404 })
}, websocket: {
  message(ws, raw) {
    const request = JSON.parse(String(raw)) as { id: number; method: string; params: Record<string, any> }
    const id = ws.data.id
    const mac = id === 'mac'
    const handlers: Record<string, () => unknown> = {
      'daemon.info': () => ({ protocol_version: PROTOCOL_VERSION, environment_id: id, machine_id: id, hostname: NAMES[id], version: id === 'old' ? '0.20.0' : '0.27.3', os: cards.find((c) => c.machine_id === id)!.os, arch: 'arm64', data_dir: '/fixture', scopes: [], started_at: at, features: featuresOf(id) }),
      'projects.list': () => ({ projects: mac ? [project] : [] }),
      'threads.list': () => ({ threads: request.params.parent_thread_id ? (mac ? childrenOn(id) : []) : mac ? [thread] : childrenOn(id) }),
      'threads.get': () => ({ thread, transcript: shownTranscript(), pending_approvals: [], next_before_seq: null }),
      'threads.target.get': () => ({ target: { provider: thread.provider }, account_override: false, effective_permission_mode: 'supervised', suggested_account: 'default', ...(DELEGATED ? {} : AWAY ? { account_unavailable: true } : { quota_limited: true, waiting_until: new Date(now + 138 * 60_000).toISOString() }) }),
      'threads.messages.list': () => ({ messages: [] }),
      'events.subscribe': () => ({ subscription_id: `fixture-${id}`, head_seq: 8, replay_ready: true }),
      'tasks.list': () => ({ tasks: [] }),
      'tasks.items.list': () => ({ tasks: [] }),
      'notes.list': () => ({ notes: [] }),
      'terminals.list': () => ({ terminals: [] }),
      'spaces.list': () => ({ spaces: [] }),
      'network.status': () => network(id),
      'network.routes': () => ({ routes: [route(request.params.machine_id)] }),
      'network.client_grant': () => ({ token: 'fixture', scopes: [], routes: [route(request.params.machine_id)], signing_key: cards.find((c) => c.machine_id === request.params.machine_id)?.signing_key }),
      'outbox.list': () => ({ items: [] }),
      'settings.get': () => settings,
      'settings.update': () => { settings = request.params.settings; return settings },
      'providers.list': () => ({ providers: providers(id) }),
      'providers.accounts.list': () => ({ accounts: request.params.kind ? accounts[id].filter((a) => a.provider.kind === request.params.kind) : accounts[id] }),
      'providers.accounts.catalog': () => providers(id)[0],
      'usage.limits': () => usage(id),
      'accounts.offers': () => ({ offers: offers() }),
      'login.broker.status': () => brokerStatus(),
      'login.broker.set': () => { const { provider: kind, machine_id } = request.params; if (kind) lending[kind as 'codex'] = machine_id ?? null; return { status: brokerStatus(), rebound: [], offline: [], old_signed_out: [] } },
      // A sign-in on another machine that waits for this computer to catch the redirect.
      'providers.accounts.login.start': () => ({ id: `login-${id}`, kind: request.params.kind, mode: request.params.mode, phase: 'waiting', url: 'https://claude.ai/oauth/authorize?fixture', ...(mac ? {} : { handoff: { port: 54321, path: '/callback' } }), expires_at: new Date(now + 600_000).toISOString() }),
      'providers.accounts.login.get': () => ({ id: request.params.id, kind: 'claude-code', mode: 'browser', phase: 'waiting', url: 'https://claude.ai/oauth/authorize?fixture', handoff: { port: 54321, path: '/callback' }, expires_at: new Date(now + 600_000).toISOString() }),
      'providers.accounts.login.cancel': () => ({ id: request.params.id, kind: 'claude-code', mode: 'browser', phase: 'canceled', expires_at: at }),
    }
    const handler = id === 'old' && request.method === 'providers.accounts.list' ? undefined : handlers[request.method]
    ws.send(JSON.stringify(handler
      ? { jsonrpc: '2.0', id: request.id, result: handler() }
      : { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'method not found' } }))
  },
} })
// Who lends each agent: fedora Claude Code, kdi-vps Codex (it is often away, so new machines sign in themselves).
const lending: Record<'claude-code' | 'codex' | 'omp', string | null> = { 'claude-code': 'fedora', codex: 'vps', omp: null }
const brokerStatus = () => ({
  broker: { machine_id: 'fedora', name: 'fedora' }, is_broker: false, providers: [], loans: [],
  lender: { machine_id: 'fedora', name: 'fedora', chosen: 'manual', usable_for_new: true },
  lenders: (['mac', 'fedora', 'vps', 'studio'] as Id[]).map((m) => ({ machine_id: m, name: NAMES[m], is_self: m === 'mac', online: m !== 'studio', supported: m !== 'studio', is_lender: Object.values(lending).includes(m), can_share: m !== 'studio', ...(m === 'studio' ? { reason: 'studio is offline. Bring it online first.' } : {}) })),
  lenders_by_kind: Object.fromEntries(Object.entries(lending).filter(([, m]) => m).map(([kind, m]) => [kind, { machine_id: m, name: NAMES[m as Id], chosen: 'manual', usable_for_new: m !== 'vps', ...(m === 'vps' ? { reason: 'kdi-vps is often offline, so new machines sign in themselves.' } : {}) }])),
})
const route = (id: string) => ({ kind: 'direct_advertised' as const, url: `http://127.0.0.1:${server.port}/${id}` })

const config = process.env.KYBERN_CLIENT_CONFIG_DIR!
mkdirSync(config, { recursive: true })
writeMachineRecords(config, cards.map((card) => ({ machineId: card.machine_id, name: card.name, member: true, routes: [route(card.machine_id)], signingKey: card.signing_key!, legacyProfileId: card.machine_id === 'mac' ? 'local' : card.machine_id })))
for (const id of ids) await writeCredential(`machine:${id}`, 'fixture')
// The sidebar opens on the thread at its limit; the network intro was answered.
writeFileSync(path.join(config, 'network-intro.json'), JSON.stringify({ choice: 'later' }))
process.env.KYBERN_URL = `${route('mac').url.replace('http', 'ws')}/ws`
process.env.KYBERN_TOKEN = 'fixture'
process.env.KYBERN_GPUIX_THREAD = thread.id
await import('../main.tsx')
process.stdin.on('end', () => { server.stop(true); process.exit(0) })
