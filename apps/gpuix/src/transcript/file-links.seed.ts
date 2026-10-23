// Seeds a scratch daemon for `file-links.verify.ts` (ADE-66): a workspace whose agent wrote its links from another folder, a
// user's pasted image in the harness's session folder, and the agent's Read of it.
//   KYBERN_DATA_DIR=<…gpuix-scratch…/data> bun src/transcript/file-links.seed.ts
import { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import path from 'node:path'
import { connect } from '../../visual/fixture.ts'

const data = process.env.KYBERN_DATA_DIR ?? ''
if (!data.includes('gpuix-scratch')) throw Error('Scratch daemon required')
const root = path.dirname(data)
const workspace = path.join(root, 'workspace')
const session = randomUUID()
const imageDir = `/private/tmp/claude-501/kybern-verify-66/${session}/images`

// The workspace: the file the links name, a long one so line 390 is not on the first screen.
const rows = path.join(workspace, 'apps/gpuix/src/sidebar/rows.tsx')
mkdirSync(path.dirname(rows), { recursive: true })
writeFileSync(rows, Array.from({ length: 420 }, (_, i) => i + 1 === 390 ? 'export const MARKED_LINE_390 = true' : `// rows.tsx line ${i + 1}`).join('\n') + '\n')
for (const args of [['init', '-q', '-b', 'main'], ['add', '.'], ['-c', 'user.name=f', '-c', 'user.email=f@x.io', 'commit', '-q', '-m', 'init']]) Bun.spawnSync(['git', ...args], { cwd: workspace })

// A 160x100 PNG, so the viewer has something to show.
const crc = (buf: Buffer) => { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)) } return ~c >>> 0 }
const chunk = (type: string, body: Buffer) => { const out = Buffer.alloc(12 + body.length); out.writeUInt32BE(body.length, 0); out.write(type, 4, 'latin1'); body.copy(out, 8); out.writeUInt32BE(crc(out.subarray(4, 8 + body.length)), 8 + body.length); return out }
const [w, h] = [160, 100]
const header = Buffer.alloc(13); header.writeUInt32BE(w, 0); header.writeUInt32BE(h, 4); header[8] = 8; header[9] = 2
const raw = Buffer.concat(Array.from({ length: h }, (_, y) => Buffer.concat([Buffer.from([0]), ...Array.from({ length: w }, (_, x) => Buffer.from([40 + x, 120, 200 - y]))])))
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
mkdirSync(imageDir, { recursive: true })
writeFileSync(path.join(imageDir, '1.png'), png)

const client = await connect({ daemonPid: 0, seeded: true, port: Number(readFileSync(path.join(data, 'daemon.port'), 'utf8').trim()), token: readFileSync(path.join(data, 'daemon.token'), 'utf8').trim() })
const project = await client.call('projects.add', { path: workspace, name: 'ade66-workspace' })
const thread = await client.call('threads.create', { project_id: project.id, provider: { kind: 'claude-code', instance: 'default' }, permission_mode: 'supervised', title: 'ADE-66 links' })
const db = new Database(path.join(data, 'state.sqlite'))
db.exec('PRAGMA busy_timeout = 5000')
const insert = db.prepare('INSERT INTO events(thread_id, turn_id, at, kind, payload) VALUES (?1, ?2, ?3, ?4, ?5)')
const usage = { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0 }
const read = { id: 'toolu_read66', name: 'Read', input: { file_path: path.join(imageDir, '1.png') } }
const turn1 = randomUUID(), turn2 = randomUUID(), a1 = randomUUID(), a2 = randomUUID()
const events: ({ turn: string; kind: string } & Record<string, unknown>)[] = [
  { turn: turn1, kind: 'turn_started', message_id: randomUUID(), message: { parts: [{ type: 'text', text: 'The sidebar row looks off, see my screenshot.' }, { type: 'image', media_type: 'image/png', data: png.toString('base64') }] } },
  { turn: turn1, kind: 'tool_call_started', call: read, origin: { kind: 'root' } },
  { turn: turn1, kind: 'tool_call_completed', tool_call_id: read.id, output: 'ok', is_error: false },
  { turn: turn1, kind: 'assistant_message_completed', message_id: a1, origin: { kind: 'root' }, text: '[rows.tsx:390](apps/gpuix/src/sidebar/rows.tsx#L390) is the row, linked from the workspace root.', thinking: null },
  { turn: turn1, kind: 'turn_completed', stop_reason: 'completed', usage, cost_usd: 0, duration_ms: 1000, terminal_message_id: a1 },
  { turn: turn2, kind: 'turn_started', message_id: randomUUID(), message: { parts: [{ type: 'text', text: 'And the same one again?' }] } },
  { turn: turn2, kind: 'assistant_message_completed', message_id: a2, origin: { kind: 'root' }, text: '[rows.tsx:390](sidebar/rows.tsx#L390) is the same row, linked from the folder my shell was in.', thinking: null },
  { turn: turn2, kind: 'turn_completed', stop_reason: 'completed', usage, cost_usd: 0, duration_ms: 1000, terminal_message_id: a2 },
]
const start = Date.now() - 600_000
events.forEach((ev, i) => { const { turn, ...payload } = ev; insert.run(thread.id, turn, new Date(start + i * 1500).toISOString(), ev.kind, JSON.stringify(payload)) })
const last = db.query('SELECT max(seq) AS s FROM events WHERE thread_id = ?1').get(thread.id) as { s: number }
db.prepare('UPDATE threads SET last_seq = ?2, status = ?3, provider_session_id = ?4 WHERE id = ?1').run(thread.id, last.s, 'idle', session)
db.close()
console.log(JSON.stringify({ thread: thread.id, session, imageDir, workspace }))
process.exit(0)
