// Seeds a scratch daemon for `visual.verify.ts` (ADE-69): a thread with a turn and two published visuals (controls,
// tall). The daemon must be this checkout's build (`KYBERND`), which draws pictures; its preview browser is linked
// from the user's install so nothing is downloaded.
//   VISUAL_SCRATCH=/Users/mymac/projects/ade-gpuix-scratch/visual-69 KYBERND=<checkout>/target/debug/kybernd bun src/transcript/visual.seed.ts
import { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { DATA_DIR, SCRATCH, connect, startDaemon } from '../../visual/fixture.ts'
import { BUNDLE_PAGE, CHECKLIST_PAGE } from './visual.pages.ts'

const BROWSER = '154.0.8037.92'
const installed = path.join(homedir(), '.kybern/cache/html-preview', BROWSER)
const linked = path.join(DATA_DIR, 'cache/html-preview', BROWSER)
const state = await startDaemon(true)
if (existsSync(installed) && !existsSync(linked)) { mkdirSync(path.dirname(linked), { recursive: true }); symlinkSync(installed, linked) }
const client = await connect(state)
const workspace = path.join(SCRATCH, 'workspace')
mkdirSync(workspace, { recursive: true })
const project = await client.call('projects.add', { path: workspace, name: 'visuals-69' })
const thread = await client.call('threads.create', { project_id: project.id, provider: { kind: 'claude-code', instance: 'default' }, permission_mode: 'supervised', title: 'Visuals 69' })
const db = new Database(path.join(DATA_DIR, 'state.sqlite'))
db.exec('PRAGMA busy_timeout = 5000')
const insert = db.prepare('INSERT INTO events(thread_id, turn_id, at, kind, payload) VALUES (?1, ?2, ?3, ?4, ?5)')
const usage = { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0 }
const turn = randomUUID(), answer = randomUUID()
const events = [
  { kind: 'turn_started', message_id: randomUUID(), message: { parts: [{ type: 'text', text: 'Show the bundle sizes and the release checklist.' }] } },
  { kind: 'assistant_message_completed', message_id: answer, origin: { kind: 'root' }, text: 'The threads route is the heaviest; the checklist has 19 steps open.', thinking: null },
  { kind: 'turn_completed', stop_reason: 'completed', usage, cost_usd: 0, duration_ms: 1000, terminal_message_id: answer },
]
const start = Date.now() - 600_000
events.forEach((ev, i) => insert.run(thread.id, turn, new Date(start + i * 1500).toISOString(), ev.kind, JSON.stringify(ev)))
const last = db.query('SELECT max(seq) AS s FROM events WHERE thread_id = ?1').get(thread.id) as { s: number }
db.prepare('UPDATE threads SET last_seq = ?2, status = ?3 WHERE id = ?1').run(thread.id, last.s, 'idle')
db.close()
const bundle = await client.call('threads.visuals.publish', { thread_id: thread.id, title: 'Bundle size by route', height: 600, html: BUNDLE_PAGE })
const checklist = await client.call('threads.visuals.publish', { thread_id: thread.id, title: 'Release checklist', height: 2000, html: CHECKLIST_PAGE })
console.log(JSON.stringify({ thread: thread.id, project: project.id, workspace, bundle: bundle.visual.id, checklist: checklist.visual.id, port: state.port }))
process.exit(0)
