// Seeds a scratch daemon for `outside-links.verify.ts` (#220): a workspace and a conversation whose agent linked a file in its
// scratchpad (inside the system's temp folder) and one in another folder.
//   KYBERN_DATA_DIR=<…gpuix-scratch…/data> bun src/transcript/outside-links.seed.ts
import { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { connect } from '../../visual/fixture.ts'

const data = process.env.KYBERN_DATA_DIR ?? ''
if (!data.includes('gpuix-scratch')) throw Error('Scratch daemon required')
const root = path.dirname(data)
const workspace = path.join(root, 'workspace')
const slash = (p: string) => p.replaceAll('\\', '/')

mkdirSync(workspace, { recursive: true })
writeFileSync(path.join(workspace, 'README.md'), '# Workspace\n')
for (const args of [['init', '-q', '-b', 'main'], ['add', '.'], ['-c', 'user.name=f', '-c', 'user.email=f@x.io', 'commit', '-q', '-m', 'init']]) Bun.spawnSync(['git', ...args], { cwd: workspace })

// The agent's scratchpad, in the system's temp folder, and another folder outside the workspace.
const scratchpad = path.join(tmpdir(), 'claude', `kybern-verify-220-${randomUUID().slice(0, 8)}`, 'scratchpad')
const elsewhere = path.join(root, 'elsewhere')
mkdirSync(scratchpad, { recursive: true })
mkdirSync(elsewhere, { recursive: true })
const plan = path.join(scratchpad, 'plan.md')
const notes = path.join(elsewhere, 'notes.md')
writeFileSync(plan, '# Plan\n\nWritten by the agent into its scratchpad.\n\n- Read it here\n- It cannot be edited from Kybern\n')
writeFileSync(notes, '# Notes\n\nA file in another folder.\n')

const client = await connect({ daemonPid: 0, seeded: true, port: Number(readFileSync(path.join(data, 'daemon.port'), 'utf8').trim()), token: readFileSync(path.join(data, 'daemon.token'), 'utf8').trim() })
const project = await client.call('projects.add', { path: workspace, name: 'outside-links' })
const thread = await client.call('threads.create', { project_id: project.id, provider: { kind: 'claude-code', instance: 'default' }, permission_mode: 'supervised', title: 'Outside links' })
const db = new Database(path.join(data, 'state.sqlite'))
db.exec('PRAGMA busy_timeout = 5000')
const insert = db.prepare('INSERT INTO events(thread_id, turn_id, at, kind, payload) VALUES (?1, ?2, ?3, ?4, ?5)')
const usage = { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0 }
const turn1 = randomUUID(), turn2 = randomUUID(), a1 = randomUUID(), a2 = randomUUID()
const events: ({ turn: string; kind: string } & Record<string, unknown>)[] = [
  { turn: turn1, kind: 'turn_started', message_id: randomUUID(), message: { parts: [{ type: 'text', text: 'Where is the plan?' }] } },
  { turn: turn1, kind: 'assistant_message_completed', message_id: a1, origin: { kind: 'root' }, text: `The plan is in [plan.md](<${slash(plan)}>), in my scratchpad.`, thinking: null },
  { turn: turn1, kind: 'turn_completed', stop_reason: 'completed', usage, cost_usd: 0, duration_ms: 1000, terminal_message_id: a1 },
  { turn: turn2, kind: 'turn_started', message_id: randomUUID(), message: { parts: [{ type: 'text', text: 'And the notes?' }] } },
  { turn: turn2, kind: 'assistant_message_completed', message_id: a2, origin: { kind: 'root' }, text: `The notes are in [notes.md](<${slash(notes)}>), in another folder.`, thinking: null },
  { turn: turn2, kind: 'turn_completed', stop_reason: 'completed', usage, cost_usd: 0, duration_ms: 1000, terminal_message_id: a2 },
]
const start = Date.now() - 600_000
events.forEach((ev, i) => { const { turn, ...payload } = ev; insert.run(thread.id, turn, new Date(start + i * 1500).toISOString(), ev.kind, JSON.stringify(payload)) })
const last = db.query('SELECT max(seq) AS s FROM events WHERE thread_id = ?1').get(thread.id) as { s: number }
db.prepare('UPDATE threads SET last_seq = ?2, status = ?3, provider_session_id = ?4 WHERE id = ?1').run(thread.id, last.s, 'idle', randomUUID())
db.close()
console.log(JSON.stringify({ thread: thread.id, workspace, scratchpad, elsewhere }))
process.exit(0)
