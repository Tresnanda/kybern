/**
 * Scratch-only workload for the instant-load bench (#248). Never launches an agent, never touches ~/.kybern.
 *
 *   bun perf/instant-load-2026-11/fixture.ts --daemon <kybernd> [--force]
 *
 * Starts the given daemon once on `<worktree>/.scratch/gpuix/fixture-pristine` (port 4420) so it creates its schema,
 * stops it, and writes: 20 projects × 50 threads (1,000), a short thread (4 turns), a medium thread (200 turns) and a
 * long thread (3,000 turns, 18,000+ events with tool calls and ~5 KB tool outputs). The bench copies this folder for
 * every daemon it starts, so variants never share caches or migrations.
 */
import { Database } from 'bun:sqlite'
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { PRISTINE, assertScratchDir, startDaemon, type FixtureIds } from './scratch.ts'

const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined }
const exe = arg('--daemon') ?? process.env.KYBERN_TEST_DAEMON
if (!exe) throw Error('Pass --daemon <path to kybernd>')
const dir = assertScratchDir(PRISTINE)
if (existsSync(dir)) {
  if (!process.argv.includes('--force')) throw Error(`${dir} exists; pass --force to rebuild it`)
  rmSync(dir, { recursive: true, force: true })
}
mkdirSync(dir, { recursive: true })

// The daemon creates and migrates the schema; the rows go in while it is stopped.
const daemon = await startDaemon(path.resolve(exe), dir, 4420)
await Bun.sleep(500)
await daemon.stop()

const PROJECTS = 20, PER_PROJECT = 50
const base = Date.parse('2026-10-01T09:00:00Z')
const iso = (minutes: number) => new Date(base + minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
const db = new Database(path.join(dir, 'state.sqlite'))
const ids: FixtureIds = { short: '', medium: '', long: '', others: [], projects: PROJECTS, threads: 0, events: 0, longTurns: 3000, mediumTurns: 200 }
try {
  db.exec('PRAGMA journal_mode=WAL')
  db.transaction(() => {
    const project = db.query('INSERT INTO projects(id,name,path,is_git,created_at,updated_at,task_prefix) VALUES (?,?,?,0,?,?,?)')
    const thread = db.query("INSERT INTO threads(id,project_id,title,provider_kind,provider_instance,permission_mode,status,cwd,created_at,updated_at) VALUES (?,?,?,'claude-code','default','supervised','idle',?,?,?)")
    const event = db.query('INSERT INTO events(thread_id,turn_id,at,kind,payload) VALUES (?,?,?,?,?)')
    const lastSeq = db.query('UPDATE threads SET last_seq=(SELECT MAX(seq) FROM events WHERE thread_id=?) WHERE id=?')
    let clock = 0
    const turns = (id: string, n: number, toolBytes: number) => {
      for (let i = 0; i < n; i++) {
        const turn = crypto.randomUUID(), message = crypto.randomUUID(), tool = crypto.randomUUID(), at = iso(clock++)
        const task = { id: `process-${i}`, thread_id: id, origin_turn_id: turn, kind: 'process', status: 'completed', title: 'Run checks', started_at: at, updated_at: at, completed_at: at }
        const payloads = [
          { kind: 'turn_started', message_id: crypto.randomUUID(), message: { parts: [{ type: 'text', text: `Instant-load fixture turn ${i + 1}: check the change, keep formatting and history.` }] } },
          { kind: 'tool_call_started', call: { id: tool, name: 'Read', input: { file_path: `src/module-${i % 40}.ts` } }, origin: { kind: 'root' } },
          { kind: 'tool_call_completed', tool_call_id: tool, output: { text: 'export const instant = true;\n'.repeat(Math.max(1, Math.round(toolBytes / 29))) }, is_error: false },
          ...(i % 25 === 0 ? [{ kind: 'runtime_task_completed', task }] : []),
          { kind: 'assistant_message_completed', message_id: message, origin: { kind: 'root' }, text: `## Result ${i + 1}\n\nThe **formatted answer** keeps stable rows.\n\n\x60\x60\x60typescript\nexport const ready = ${i + 1};\n\x60\x60\x60\n\n- Content first\n- Then live events\n\n| Check | Result |\n| --- | --- |\n| History | Kept |\n\n${'An explanation of the change and how it was verified. '.repeat(6)}`, thinking: null },
          { kind: 'turn_completed', stop_reason: 'completed', usage: { input_tokens: 100, output_tokens: 100, cache_read_tokens: 0, cache_write_tokens: 0 }, cost_usd: null, duration_ms: 1000, terminal_message_id: message },
        ]
        for (const payload of payloads) { event.run(id, turn, at, payload.kind, JSON.stringify(payload)); ids.events++ }
      }
      lastSeq.run(id, id)
    }
    for (let p = 0; p < PROJECTS; p++) {
      const projectId = crypto.randomUUID(), cwd = path.join(dir, `project-${String(p).padStart(2, '0')}`)
      mkdirSync(cwd, { recursive: true })
      project.run(projectId, `Instant project ${String(p + 1).padStart(2, '0')}`, cwd, iso(0), iso(0), `IL${p}`)
      for (let t = 0; t < PER_PROJECT; t++) {
        const id = crypto.randomUUID()
        // Project 1 holds the measured threads; they are written last so they are the newest rows.
        const role = p === 0 ? (t === 0 ? 'long' : t === 1 ? 'medium' : t === 2 ? 'short' : null) : null
        const title = role ? `Instant ${role} thread` : `Instant conversation ${p + 1}-${t + 1}`
        thread.run(id, projectId, title, cwd, iso(clock), iso(clock))
        ids.threads++
        if (role) ids[role] = id
        else { turns(id, 3, 600); if (ids.others.length < 40) ids.others.push(id) }
      }
    }
    turns(ids.short, 4, 600)
    turns(ids.medium, ids.mediumTurns, 2_000)
    turns(ids.long, ids.longTurns, 5_000)
    // updated_at follows the last event so the sidebar's newest-first order is the order written.
    // Projects belong to the daemon's default space, or the sidebar lists none of them.
    db.exec(`UPDATE projects SET space_id = (SELECT id FROM spaces ORDER BY position LIMIT 1) WHERE space_id IS NULL`)
    db.exec(`UPDATE threads SET updated_at = COALESCE((SELECT MAX(at) FROM events WHERE events.thread_id = threads.id), updated_at)`)
    // New-schema fixtures have list-cursor triggers; the offline timestamp edit
    // above otherwise marks every row beyond the event head forever. Match a
    // fixture migrated from the old schema, whose cursor starts at last_seq.
    if (db.query<{ name: string }, []>('PRAGMA table_info(threads)').all().some(column => column.name === 'change_seq')) {
      db.exec('UPDATE threads SET change_seq = last_seq WHERE change_seq > (SELECT COALESCE(MAX(seq), 0) FROM events)')
    }
  })()
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
} finally { db.close() }
writeFileSync(path.join(dir, 'fixture.json'), JSON.stringify(ids, null, 2))
console.log(JSON.stringify({ fixture: dir, ...ids, others: ids.others.length }))
