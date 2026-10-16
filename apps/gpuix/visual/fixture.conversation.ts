/**
 * Conversation fixtures for the visual pair tool: threads whose event history is
 * written straight into the scratch daemon's SQLite store (WAL, so the running
 * daemon reads it on demand). Only ever touches the scratch data dir.
 */
import { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { SCRATCH, DATA_DIR, readState } from './fixture.ts'
import type { KybernClient } from '../../../packages/kybern-client/src/client.ts'

const PROXY_READY = path.join(SCRATCH, 'conversation-proxy.json')
const ACTIVITY_DATA = path.join(SCRATCH, 'conversation-activity.json')
export const CONVERSATION_IDS = path.join(SCRATCH, 'conversation-ids.json')
export type ConversationIds = Record<string, string>
export function readConversationIds(): ConversationIds {
  try { return JSON.parse(readFileSync(CONVERSATION_IDS, 'utf8')) } catch { return {} }
}

const REPLY = `Here is what I found in \`formatDate\`. The helper mixes **local** and *UTC* handling, which is why the tests fail near midnight.

## Plan

1. Normalise the input to a \`Date\` once.
2. Format through \`Intl.DateTimeFormat\` with an explicit \`timeZone\`.
3. Cover the edge cases in a table-driven test.

- Keeps the public signature
- Removes the manual padding
- See [the Intl docs](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat) for options

| Input | Zone | Output |
| --- | --- | --- |
| \`2026-10-15T23:30:00Z\` | UTC | Oct 15 |
| \`2026-10-15T23:30:00Z\` | Asia/Tokyo | Oct 16 |

\`\`\`ts
export function formatDate(input: Date | string, timeZone = 'UTC') {
  const date = typeof input === 'string' ? new Date(input) : input
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone }).format(date)
}
\`\`\`

> The old padding code is gone, so there is nothing left to drift.`

type Ev = { turn?: string; kind: string; [k: string]: unknown }

export function conversationEvents(): { title: string; events: Ev[] }[] {
  const turn1 = randomUUID(), turn2 = randomUUID()
  const m = () => randomUUID()
  const u1 = m(), a1 = m(), a2 = m(), u2 = m(), a3 = m()
  const usage = { input_tokens: 4200, output_tokens: 880, cache_read_tokens: 12000, cache_write_tokens: 300 }
  const read = { id: 'toolu_read1', name: 'Read', input: { file_path: `${SCRATCH}/kybern-app/src/date.ts` } }
  const edit = { id: 'toolu_edit1', name: 'Edit', input: { file_path: `${SCRATCH}/kybern-app/src/date.ts`, old_string: 'const pad = (n: number) => String(n).padStart(2, "0")', new_string: 'const fmt = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" })' } }
  const bash = { id: 'toolu_bash1', name: 'Bash', input: { command: 'bun test src/date.test.ts', description: 'Run the date tests' } }
  const events: Ev[] = [
    { turn: turn1, kind: 'turn_started', message_id: u1, message: { parts: [{ type: 'text', text: 'Tidy up the date helper and add a test. The tests fail near midnight.' }] } },
    { turn: turn1, kind: 'assistant_thinking_delta', message_id: a1, origin: { kind: 'root' }, delta: 'The helper pads manually and mixes local with UTC. I should read the file before changing anything.' },
    { turn: turn1, kind: 'assistant_thinking_completed', message_id: a1, origin: { kind: 'root' } },
    { turn: turn1, kind: 'assistant_message_completed', message_id: a1, origin: { kind: 'root' }, text: 'I will start by reading the helper.', thinking: 'The helper pads manually and mixes local with UTC. I should read the file before changing anything.' },
    { turn: turn1, kind: 'tool_call_started', call: read, origin: { kind: 'root' } },
    { turn: turn1, kind: 'tool_call_completed', tool_call_id: read.id, output: 'export function formatDate(d: Date) {\n  const pad = (n: number) => String(n).padStart(2, "0")\n  return `${d.getMonth() + 1}/${pad(d.getDate())}`\n}\n', is_error: false },
    { turn: turn1, kind: 'tool_call_started', call: edit, origin: { kind: 'root' } },
    { turn: turn1, kind: 'tool_call_completed', tool_call_id: edit.id, output: 'The file has been updated.', is_error: false },
    { turn: turn1, kind: 'tool_call_started', call: bash, origin: { kind: 'root' } },
    { turn: turn1, kind: 'tool_call_completed', tool_call_id: bash.id, output: 'bun test v1.2\n\nsrc/date.test.ts:\n✓ formats in UTC [1.2ms]\n✓ rolls over in Tokyo [0.4ms]\n\n 2 pass\n 0 fail', is_error: false },
    { turn: turn1, kind: 'assistant_message_completed', message_id: a2, origin: { kind: 'root' }, text: REPLY, thinking: null },
    { turn: turn1, kind: 'turn_completed', stop_reason: 'completed', usage, cost_usd: 0.0214, duration_ms: 48000, terminal_message_id: a2 },
    { turn: turn2, kind: 'turn_started', message_id: u2, message: { parts: [{ type: 'text', text: 'Thanks. Does `formatDate` handle `null`?' }] } },
    { turn: turn2, kind: 'assistant_message_completed', message_id: a3, origin: { kind: 'root' }, text: 'No. It throws on `null`; I can add a guard that returns an empty string.', thinking: null },
    { turn: turn2, kind: 'turn_completed', stop_reason: 'completed', usage, cost_usd: 0.004, duration_ms: 6000, terminal_message_id: a3 },
  ]
  const diffTurn = randomUUID(), diffUser = m(), diffAnswer = m()
  const shortIds = new Map<string, string>()
  const shortEvents = JSON.parse(JSON.stringify(events.filter((_, i) => [0, 10, 11, 12, 13, 14].includes(i)).map(ev => ev.kind === 'assistant_message_completed' ? { ...ev, text: 'Done. The date helper is updated.' } : ev)).replace(/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/g, id => { if (!shortIds.has(id)) shortIds.set(id, randomUUID()); return shortIds.get(id)! }))
  // A long thread for the transcript rail and the markdown rhythm checks: thirty turns, every other reply rich.
  const longEvents: Ev[] = []
  for (let i = 0; i < 30; i++) {
    const turn = randomUUID(), user = m(), answer = m()
    longEvents.push(
      { turn, kind: 'turn_started', message_id: user, message: { parts: [{ type: 'text', text: `Question ${i + 1}: how should the ${['date helper', 'time zone handling', 'formatter tests', 'locale fallbacks', 'rollover logic'][i % 5]} change?` }] } },
      { turn, kind: 'assistant_message_completed', message_id: answer, origin: { kind: 'root' }, text: i % 2 === 1 ? `Answer ${i + 1}. ${REPLY}` : `Answer ${i + 1}. Keep it as it is for now; nothing here needs to change.`, thinking: null },
      { turn, kind: 'turn_completed', stop_reason: 'completed', usage, cost_usd: 0.004, duration_ms: 6000, terminal_message_id: answer },
    )
  }
  const richTurn = randomUUID(), richAnswer = m()
  const richEvents: Ev[] = [
    { turn: richTurn, kind: 'turn_started', message_id: m(), message: { parts: [{ type: 'text', text: 'Summarise what you found in formatDate.' }] } },
    { turn: richTurn, kind: 'assistant_message_completed', message_id: richAnswer, origin: { kind: 'root' }, text: REPLY, thinking: null },
    { turn: richTurn, kind: 'turn_completed', stop_reason: 'completed', usage, cost_usd: 0.004, duration_ms: 6000, terminal_message_id: richAnswer },
  ]
  return [{ title: 'Date helper cleanup', events }, { title: 'Long review thread', events: longEvents }, { title: 'Rich reply', events: richEvents }, { title: 'Subagent launches', events: [{ turn: diffTurn, kind: 'turn_started', message_id: m(), message: { parts: [{ type: 'text', text: 'Review cancellation and formatting in parallel.' }] } }, ...['Cancellation review', 'Formatting review'].map((title, i) => ({ turn: diffTurn, kind: 'tool_call_started', call: { id: `visual-agent-${i}`, name: 'Agent', input: { description: title, prompt: `Review ${title.toLowerCase()} and report concrete findings.`, subagent_type: 'general-purpose' } }, origin: { kind: 'root' } }))] }, { title: 'Context status', events: [{ kind: 'provider_usage_updated', usage: { context: { used_tokens: 48000, window_tokens: 200000 } } }] }, { title: 'Empty conversation', events: [] }, { title: 'Short exchange', events: shortEvents }, { title: 'Inline file changes', events: [
    { turn: diffTurn, kind: 'turn_started', message_id: diffUser, message: { parts: [{ type: 'text', text: 'Handle null input in the date helper.' }] } },
    { turn: diffTurn, kind: 'assistant_message_completed', message_id: diffAnswer, origin: { kind: 'root' }, text: 'Added a null guard before parsing the date.', thinking: null },
    { turn: diffTurn, kind: 'turn_completed', stop_reason: 'completed', usage, cost_usd: 0.004, duration_ms: 6000, terminal_message_id: diffAnswer },
  ] }]

}

/** Create the conversation threads over RPC, then append their events to the store. */
export async function seed(client: KybernClient, ctx: { projects: { id: string }[] }) {
  writeFileSync(path.join(SCRATCH, 'review-notes.txt'), 'Review the date helper and add null coverage.\n')
  const ids: ConversationIds = {}
  const db = new Database(path.join(DATA_DIR, 'state.sqlite'))
  db.exec('PRAGMA busy_timeout = 5000')
  for (const { title, events } of [...conversationEvents(), ...['Approve a command', 'Request a service key', 'Review project brief', 'Review coordinator settings', 'Held review message', 'Pending permissions', 'Usage recovery', 'Queued follow-ups', 'Helper review', 'Native subagents'].map(title => ({ title, events: [] as Ev[] }))]) {
    const thread = await client.call('threads.create', { project_id: ctx.projects[0]!.id, provider: { kind: 'claude-code', instance: 'default' }, permission_mode: 'supervised', title })
    ids[title] = thread.id
    const insert = db.prepare('INSERT INTO events(thread_id, turn_id, at, kind, payload) VALUES (?1, ?2, ?3, ?4, ?5)')
    const start = Date.now() - 3600_000
    events.forEach((ev, i) => {
      const { turn, ...payload } = ev
      insert.run(thread.id, turn ?? null, new Date(start + i * 1500).toISOString(), ev.kind, JSON.stringify(payload))
    })
    if (title === 'Inline file changes') {
      // Unreferenced synthetic commits in the SCRATCH repository only. They
      // supply deterministic daemon diffs without touching a checkout/index.
      const git = (args: string[], input?: string) => {
        const result = Bun.spawnSync(['git', ...args], { cwd: thread.cwd, stdin: input ? Buffer.from(input) : undefined, env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' } })
        if (result.exitCode) throw new Error(result.stderr.toString())
        return result.stdout.toString().trim()
      }
      const snapshot = (source: string) => {
        const blob = git(['hash-object', '-w', '--stdin'], source)
        const tree = git(['mktree'], `100644 blob ${blob}\tdate.ts\n`)
        return git(['commit-tree', tree], 'Visual diff fixture\n')
      }
      const before = snapshot("export function formatDate(input: Date | string) {\n  return new Date(input).toISOString()\n}\n")
      const after = snapshot("export function formatDate(input: Date | string | null) {\n  if (input === null) return ''\n  return new Date(input).toISOString()\n}\n")
      db.prepare('INSERT INTO checkpoints(turn_id, thread_id, before_commit, after_commit, created_at) VALUES (?1, ?2, ?3, ?4, ?5)').run(events[0]!.turn!, thread.id, before, after, new Date(start).toISOString())
    }
    const requests: Record<string, { tool_name: string; input: unknown; summary: string }> = {
      'Approve a command': { tool_name: 'Bash', input: { command: 'bun test src/date.test.ts', description: 'Run the date helper tests' }, summary: 'Run the date helper tests' },
      'Request a service key': { tool_name: 'kybern_request_secret', input: { label: 'Service API key', reason: 'Needed to connect this project to the service.', env_key: 'SERVICE_API_KEY', file: '.env', replaces: true }, summary: '' },
      'Review project brief': { tool_name: 'kybern_coordinator_brief', input: { text: 'Build a focused companion for the desktop app.\n\nPreserve keyboard navigation, readable transcripts, and low idle resource use.', replaces: false }, summary: '' },
      'Review coordinator settings': { tool_name: 'kybern_coordinator_settings', input: { reason: 'Use separate workspaces for parallel implementation.', changes: [{ path: 'workspace', label: 'Workspace', old: 'shared', new: 'worktree' }, { path: 'review', label: 'Review changes', old: false, new: true }] }, summary: '' },
    }
    const request = requests[title]
    if (request) {
      const approval = { id: randomUUID(), thread_id: thread.id, turn_id: randomUUID(), tool_call_id: 'visual-request', created_at: new Date(start).toISOString(), suggestions: [], ...request }
      db.prepare('INSERT INTO approvals(id, thread_id, turn_id, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5)').run(approval.id, thread.id, approval.turn_id, JSON.stringify(approval), approval.created_at)
    }
    const last = db.query('SELECT max(seq) AS s FROM events WHERE thread_id = ?1').get(thread.id) as { s: number }
    db.prepare('UPDATE threads SET last_seq = ?2, status = ?3 WHERE id = ?1').run(thread.id, last.s ?? 0, ['Queued follow-ups', 'Subagent launches'].includes(title) ? 'running' : 'idle')
  }
  const children = []
  const at = new Date(Date.now() - 60_000).toISOString()
  for (const [title, parentTitle, native] of [['Check date edge cases', 'Helper review', false], ['Review cancellation', 'Native subagents', true], ['Review formatting', 'Native subagents', true], ['Cancellation review', 'Subagent launches', true], ['Formatting review', 'Subagent launches', true]] as const) {
    const child = await client.call('threads.create', { project_id: ctx.projects[0]!.id, provider: { kind: 'claude-code', instance: 'default' }, permission_mode: 'supervised', title })
    const launch = parentTitle === 'Subagent launches'
    const parentTurn = db.query('SELECT turn_id FROM events WHERE thread_id = ?1 ORDER BY seq LIMIT 1').get(ids[parentTitle]) as { turn_id: string } | null
    const info = native ? { ...(launch ? { tool_call_id: `visual-agent-${title === 'Cancellation review' ? 0 : 1}` } : {}), task_id: randomUUID(), native_task_id: randomUUID(), root_thread_id: ids[parentTitle], parent_turn_id: parentTurn?.turn_id ?? randomUUID(), status: 'running', started_at: at, agent_type: 'general-purpose', detail: 'Checking the requested changes and cancellation coverage.', stats: { token_count: 18240 }, capabilities: { stop: true, background: true } } : null
    db.prepare('UPDATE threads SET parent_thread_id = ?2, subagent = ?3 WHERE id = ?1').run(child.id, ids[parentTitle], info ? JSON.stringify(info) : null)
    children.push({ ...child, parent_thread_id: ids[parentTitle], subagent: info })
    ids[title] = child.id
  }
  writeFileSync(ACTIVITY_DATA, JSON.stringify({ ids, children, at }))
  db.close()
  writeFileSync(CONVERSATION_IDS, JSON.stringify(ids))
}

export async function ids(client: KybernClient): Promise<Record<string, unknown>> {
  const { threads } = await client.call('threads.list', {})
  const state = readState()!
  rmSync(PROXY_READY, { force: true })
  const child = spawn('bun', [import.meta.filename, '--proxy', JSON.stringify({ port: state.port, token: state.token })], { stdio: 'ignore' })
  child.unref()
  process.once('exit', () => child.kill())
  for (let i = 0; i < 100 && !existsSync(PROXY_READY); i++) await Bun.sleep(50)
  if (!existsSync(PROXY_READY)) throw new Error('Conversation fixture proxy did not start')
  const proxy = JSON.parse(readFileSync(PROXY_READY, 'utf8'))
  process.env.KYBERN_URL = `ws://127.0.0.1:${proxy.port}/ws`
  return { ...readConversationIds(), ...Object.fromEntries(threads.map(t => [t.title, t.id])), __project: threads.find(t => t.title === 'Date helper cleanup')?.project_id }
}

// Screen-only activity responses. All mutation methods still reach the
// upstream visual boundary, which rejects actions outside its fixture scope.
if (import.meta.main && process.argv[2] === '--proxy') {
  const config = JSON.parse(process.argv[3]!)
  const data = JSON.parse(readFileSync(ACTIVITY_DATA, 'utf8'))
  const key = (title: string) => data.ids[title]
  const server = Bun.serve<{ upstream: WebSocket; queued: string[] }>({ hostname: '127.0.0.1', port: 0,
    fetch(req, server) {
      if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') { const target = new URL(req.url); target.port = String(config.port); return fetch(new Request(target, req)) }
      const upstream = new WebSocket(`ws://127.0.0.1:${config.port}/ws`, { headers: { origin: 'tauri://localhost', Authorization: `Bearer ${config.token}` } } as never)
      if (server.upgrade(req, { data: { upstream, queued: [] } })) return
      upstream.close(); return new Response('Not found', { status: 404 })
    }, websocket: {
      open(ws) {
        ws.data.upstream.onmessage = event => ws.send(String(event.data))
        ws.data.upstream.onopen = () => { for (const raw of ws.data.queued) ws.data.upstream.send(raw); ws.data.queued = [] }
      },
      message(ws, raw) {
        const text = String(raw), req = JSON.parse(text), p = req.params ?? {}
        const reply = (result: unknown) => ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }))
        if (req.method === 'threads.messages.list' && p.thread_id === key('Held review message')) { reply({ messages: [{ id: 'visual-held', operation_id: 'visual-held', from_thread_id: key('Helper review'), to_thread_id: p.thread_id, purpose: 'question', body: 'The implementation is ready for review. Should I include the additional coverage?', state: 'held', delivery: 'queue', created_at: data.at, updated_at: data.at, held_reason: 'The sender has broader permissions.' }] }); return }
        if (req.method === 'threads.target.get' && [key('Pending permissions'), key('Usage recovery')].includes(p.thread_id)) { reply({ target: { provider: { kind: 'claude-code', instance: 'default' } }, pending_permission_mode: p.thread_id === key('Pending permissions') ? 'full-access' : null, quota_limited: p.thread_id === key('Usage recovery'), effective_permission_mode: 'supervised' }); return }
        if (req.method === 'queue.list' && (!p.thread_id || p.thread_id === key('Queued follow-ups'))) { reply({ messages: [{ id: 'visual-queue', thread_id: key('Queued follow-ups'), message: { parts: [{ type: 'text', text: 'Also cover null input in the regression tests.' }] }, created_at: data.at }] }); return }
        if (req.method === 'threads.list' && p.parent_thread_id) { reply({ threads: data.children.filter((t: any) => t.parent_thread_id === p.parent_thread_id) }); return }
        if (req.method === 'subagents.messages') { reply([]); return }
        if (ws.data.upstream.readyState === WebSocket.OPEN) ws.data.upstream.send(text); else ws.data.queued.push(text)
      },
      close(ws) { ws.data.upstream.close() },
    },
  })
  writeFileSync(PROXY_READY, JSON.stringify({ port: server.port }))
  process.once('SIGTERM', () => { server.stop(true); process.exit(0) })
}
