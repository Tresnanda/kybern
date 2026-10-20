// Composer tray fixture: a scratch daemon with a running thread, its subagents (working, finished, failed) and a proxy that
// adds the parts a scratch daemon cannot produce without real agents: a background process task and queued follow-ups
// (text, image-only, delegated results). Only ever touches the scratch dir; the proxy keeps the queue in memory so the
// app's remove button works. Stays in the foreground until killed; prints `ready <json>` once the proxy listens.
//   bun scripts/composer-tray-seed.ts [--fresh]
// then launch with KYBERN_URL=ws://127.0.0.1:<proxy>/ws KYBERN_TOKEN=<token> KYBERN_GPUIX_THREAD=<thread title>.
import { Database } from 'bun:sqlite'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { KybernClient } from '../../../packages/kybern-client/src/client.ts'
import type { QueuedMessage } from '../../../packages/kybern-client/src/types.ts'

const SCRATCH = process.env.TRAY_SCRATCH ?? '/Users/mymac/projects/ade-gpuix-scratch/composer-tray'
if (!SCRATCH.includes('gpuix-scratch')) throw new Error('TRAY_SCRATCH must be under gpuix-scratch')
const DATA = path.join(SCRATCH, 'data'), READY = path.join(SCRATCH, 'ready.json')
const PORT = Number(process.env.TRAY_DAEMON_PORT ?? 4370), PROXY_PORT = Number(process.env.TRAY_PROXY_PORT ?? 4371)
export const PARENT_TITLE = 'GPUIX phase 2: perf and motion sweep'
const IMAGE = path.resolve(import.meta.dir, '../../desktop/public/release-background.png')

if (process.argv.includes('--fresh')) rmSync(SCRATCH, { recursive: true, force: true })
mkdirSync(DATA, { recursive: true })
const daemon = spawn('/Applications/kybern.app/Contents/MacOS/kybernd', ['--data-dir', DATA, '--port', String(PORT)], { stdio: 'ignore' })
const stop = () => { try { daemon.kill('SIGTERM') } catch {} }
process.once('SIGTERM', () => { stop(); process.exit(0) })
process.once('SIGINT', () => { stop(); process.exit(0) })
process.once('exit', stop)
for (let i = 0; i < 100 && !(existsSync(path.join(DATA, 'daemon.token')) && existsSync(path.join(DATA, 'daemon.port'))); i++) await Bun.sleep(100)
const token = readFileSync(path.join(DATA, 'daemon.token'), 'utf8').trim()
const port = Number(readFileSync(path.join(DATA, 'daemon.port'), 'utf8').trim())

const client = new KybernClient({ url: `ws://127.0.0.1:${port}/ws`, token }, { createSocket: (url, t) => new WebSocket(url, { headers: { origin: 'tauri://localhost', Authorization: `Bearer ${t}` } } as unknown as string[]) })
await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('daemon timeout')), 15000); client.onStatus(s => { if (s === 'open') { clearTimeout(timer); resolve() } }); client.connect() })

const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString()
let { threads } = await client.call('threads.list', {})
let parent = threads.find(t => t.title === PARENT_TITLE)
if (!parent) {
  const repo = path.join(SCRATCH, 'kybern-app')
  mkdirSync(repo, { recursive: true })
  writeFileSync(path.join(repo, 'README.md'), '# kybern-app\n')
  for (const a of [['init', '-q', '-b', 'main'], ['add', '.'], ['commit', '-q', '-m', 'Initial commit']]) Bun.spawnSync(['git', ...a], { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'f@x.io', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'f@x.io' } })
  const project = await client.call('projects.add', { path: repo, name: 'kybern-app' })
  parent = await client.call('threads.create', { project_id: project.id, provider: { kind: 'claude-code', instance: 'default' }, permission_mode: 'supervised', title: PARENT_TITLE })
  const db = new Database(path.join(DATA, 'state.sqlite'))
  db.exec('PRAGMA busy_timeout = 5000')
  const turn = randomUUID()
  const insert = db.prepare('INSERT INTO events(thread_id, turn_id, at, kind, payload) VALUES (?1, ?2, ?3, ?4, ?5)')
  insert.run(parent.id, turn, ago(400), 'turn_started', JSON.stringify({ kind: 'turn_started', message_id: randomUUID(), message: { parts: [{ type: 'text', text: 'Study how zeron and Zed keep animations cheap, then audit our motion helpers and measure the tray under streaming.' }] } }))
  insert.run(parent.id, turn, ago(395), 'assistant_message_completed', JSON.stringify({ kind: 'assistant_message_completed', message_id: randomUUID(), origin: { kind: 'root' }, text: 'I will split this into three parallel investigations and a background strip run.', thinking: null }))
  const last = db.query('SELECT max(seq) AS s FROM events WHERE thread_id = ?1').get(parent.id) as { s: number }
  db.prepare('UPDATE threads SET last_seq = ?2, status = ?3 WHERE id = ?1').run(parent.id, last.s, 'running')
  const children: [string, string, 'completed' | 'running' | 'failed', number, number | null, string][] = [
    ['Study zeron/zui/zed animation architecture', 'Explore', 'completed', 382, 180, 'Zeron keeps one display link and paints retained layers; Zed coalesces invalidation per frame.'],
    ['Audit GPUIX motion helpers for paint-only paths', 'Explore', 'completed', 330, 202, 'Every helper except Collapse is paint-only; Collapse re-lays out per frame.'],
    ['Measure tray frame cost while the answer streams', 'general-purpose', 'running', 74, null, 'Sampling 15 s of frames with the tray expanded'],
    ['Trace the skill token measurement bug', 'general-purpose', 'failed', 140, 99, 'Unable to reproduce: the scratch daemon has no skills installed.'],
  ]
  for (const [title, type, status, started, ended, detail] of children) {
    const child = await client.call('threads.create', { project_id: project.id, provider: { kind: 'claude-code', instance: 'default' }, permission_mode: 'supervised', title })
    const info = { task_id: randomUUID(), native_task_id: randomUUID(), root_thread_id: parent.id, parent_turn_id: turn, status, started_at: ago(started), completed_at: ended === null ? null : ago(ended), agent_type: type, detail, ...(status === 'running' ? { progress: detail } : { result: detail }), stats: { token_count: 18240 }, capabilities: { stop: true, background: true } }
    db.prepare('UPDATE threads SET parent_thread_id = ?2, subagent = ?3, model = ?4 WHERE id = ?1').run(child.id, parent.id, JSON.stringify(info), 'claude-haiku-5-5')
  }
  db.close()
  threads = (await client.call('threads.list', {})).threads
  parent = threads.find(t => t.title === PARENT_TITLE)!
}
// The daemon's crash recovery settles a turn it finds running at startup: mark the fixture's turn running again.
{ const db = new Database(path.join(DATA, 'state.sqlite')); db.exec('PRAGMA busy_timeout = 5000'); db.prepare('UPDATE threads SET status = ?2 WHERE id = ?1').run(parent.id, 'running'); db.close() }
client.close?.()

// ---- proxy: queue + background task ----
const parentId = parent.id
const at = ago(30)
const imageData = readFileSync(IMAGE).toString('base64')
let queue: QueuedMessage[] = [
  { id: 'q-text', thread_id: parentId, message: { parts: [{ type: 'text', text: 'Also cover the Reduce Motion path in the strip runner and attach the before and after frames.' }] } },
  { id: 'q-image', thread_id: parentId, message: { parts: [{ type: 'image', media_type: 'image/png', data: imageData }] } },
  { id: 'q-results', thread_id: parentId, message: { parts: [{ type: 'agent_results', items: [
    { task_id: 'r1', thread_id: 'r1', title: 'Audit the dock tabs', provider: 'codex', model: 'GPT-6 Sol', role: 'review', status: 'completed', result: 'Two tabs still swap instantly.', workspace: 'shared' },
    { task_id: 'r2', thread_id: 'r2', title: 'Profile the sidebar', provider: 'codex', model: 'GPT-6 Sol', role: 'review', status: 'completed', result: 'Rows stay islands.', workspace: 'shared' },
  ] } as never] } },
]
if (process.env.TRAY_QUEUE) { const keep = process.env.TRAY_QUEUE.split(','); queue = queue.filter(q => keep.includes(q.id)) }
const command = 'cd /Users/mymac/projects/ade-motion-fps/apps/gpuix && MOTION_SHOTS=1 KYBERN_REDUCED_MOTION=0 bun scripts/motion-p2-strips.ts --theme both --reduced both'
const tasks = process.env.TRAY_TASKS === '0' ? [] : [{ id: 'task-strips', thread_id: parentId, origin_turn_id: 'turn', started_seq: 1, updated_seq: 1, kind: 'process', status: 'running', title: command, detail: null, backgrounded: true, stats: {}, capabilities: { stop: true }, started_at: ago(95), updated_at: at }]
const server = Bun.serve<{ upstream: WebSocket; pending: string[] }>({ hostname: '127.0.0.1', port: PROXY_PORT,
  fetch(req, s) {
    if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') { const target = new URL(req.url); target.port = String(port); return fetch(new Request(target, req)) }
    const upstream = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: 'tauri://localhost', Authorization: `Bearer ${token}` } } as never)
    if (s.upgrade(req, { data: { upstream, pending: [] } })) return
    upstream.close(); return new Response('Not found', { status: 404 })
  },
  websocket: {
    open(ws) {
      ws.data.upstream.onmessage = e => ws.send(String(e.data))
      ws.data.upstream.onopen = () => { for (const raw of ws.data.pending) ws.data.upstream.send(raw); ws.data.pending = [] }
    },
    message(ws, raw) {
      const text = String(raw), req = JSON.parse(text), p = req.params ?? {}
      const reply = (result: unknown) => { ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result })) }
      if (p.thread_id === parentId) {
        if (req.method === 'queue.list') return reply({ messages: queue })
        if (req.method === 'queue.add') { queue = [...queue, { id: p.id, thread_id: parentId, message: p.message }]; return reply({}) }
        if (req.method === 'queue.remove') { queue = queue.filter(q => q.id !== p.id); return reply({}) }
        if (req.method === 'tasks.list') return reply({ tasks })
      }
      if (ws.data.upstream.readyState === WebSocket.OPEN) ws.data.upstream.send(text); else ws.data.pending.push(text)
    },
    close(ws) { ws.data.upstream.close() },
  },
})
const ready = { url: `ws://127.0.0.1:${server.port}/ws`, token, daemonPid: daemon.pid, parentId, title: PARENT_TITLE }
writeFileSync(READY, JSON.stringify(ready))
console.log(`ready ${JSON.stringify(ready)}`)
await new Promise(() => {})
