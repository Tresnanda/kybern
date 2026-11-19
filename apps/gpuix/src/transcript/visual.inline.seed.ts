// Seeds a scratch daemon for `scripts/inline-visual-check.ts`: one thread with a long answer and the five inline pages
// (short with controls, ~3,000 px tall, an inner scrolling list, a canvas, a form with labels). The daemon must be this
// checkout's build (`KYBERND`), which draws full-height pictures; its preview browser is linked from the user's install.
//   KYBERND=<checkout>/target/debug/kybernd bun src/transcript/visual.inline.seed.ts
import { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { DATA_DIR, SCRATCH, connect, startDaemon } from '../../visual/fixture.ts'
import { BUNDLE_PAGE, CANVAS_PAGE, FORM_PAGE, LIST_PAGE, TALL_PAGE } from './visual.pages.ts'

const BROWSER = '154.0.8037.92'
const installed = path.join(homedir(), '.kybern/cache/html-preview', BROWSER)
const linked = path.join(DATA_DIR, 'cache/html-preview', BROWSER)
const state = await startDaemon(true)
if (existsSync(installed) && !existsSync(linked)) { mkdirSync(path.dirname(linked), { recursive: true }); symlinkSync(installed, linked) }
const client = await connect(state)
const workspace = path.join(SCRATCH, 'workspace')
mkdirSync(workspace, { recursive: true })
const project = await client.call('projects.add', { path: workspace, name: 'inline-pages' })
const thread = await client.call('threads.create', { project_id: project.id, provider: { kind: 'claude-code', instance: 'default' }, permission_mode: 'supervised', title: 'Inline pages' })
const db = new Database(path.join(DATA_DIR, 'state.sqlite'))
db.exec('PRAGMA busy_timeout = 5000')
const insert = db.prepare('INSERT INTO events(thread_id, turn_id, at, kind, payload) VALUES (?1, ?2, ?3, ?4, ?5)')
const usage = { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0 }
const turn = randomUUID(), answer = randomUUID()
const prose = Array.from({ length: 6 }, (_, i) => `Paragraph ${i + 1}: the release went out to every region; latency held under budget and the canary stayed green for the whole window.`).join('\n\n')
const events = [
  { kind: 'turn_started', message_id: randomUUID(), message: { parts: [{ type: 'text', text: 'Show the release dashboards.' }] } },
  { kind: 'assistant_message_completed', message_id: answer, origin: { kind: 'root' }, text: prose, thinking: null },
  { kind: 'turn_completed', stop_reason: 'completed', usage, cost_usd: 0, duration_ms: 1000, terminal_message_id: answer },
]
const start = Date.now() - 600_000
events.forEach((ev, i) => insert.run(thread.id, turn, new Date(start + i * 1500).toISOString(), ev.kind, JSON.stringify(ev)))
const last = db.query('SELECT max(seq) AS s FROM events WHERE thread_id = ?1').get(thread.id) as { s: number }
db.prepare('UPDATE threads SET last_seq = ?2, status = ?3 WHERE id = ?1').run(thread.id, last.s, 'idle')
db.close()
const ids: Record<string, string> = {}
for (const [name, title, html] of [['short', 'Bundle size by route', BUNDLE_PAGE], ['tall', 'Latency by region', TALL_PAGE], ['list', 'Recent deploys', LIST_PAGE], ['canvas', 'Sketch pad', CANVAS_PAGE], ['form', 'Release form', FORM_PAGE]] as const) {
  ids[name] = (await client.call('threads.visuals.publish', { thread_id: thread.id, title, height: 0, html })).visual.id
}
console.log(JSON.stringify({ thread: thread.id, project: project.id, ...ids, port: state.port }))
process.exit(0)
