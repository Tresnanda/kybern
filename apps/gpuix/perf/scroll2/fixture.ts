/** Scratch-only, reusable startup workload. Never launches an agent.
 * bun perf/startup/fixture.ts -- <command ...>
 */
import { Database } from 'bun:sqlite'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
import { assertScratchEnv } from '../../src/requests/harness.ts'

const data = '/Users/mymac/projects/ade-gpuix-scratch/perf-scroll2/sidebar'
const command = process.argv.slice(2).filter((arg, i) => i !== 0 || arg !== '--')
if (!command.length) throw Error('Pass a verification command')
assertScratchEnv({ KYBERN_DATA_DIR: data, KYBERN_URL: '' })
if (existsSync(path.join(data, 'daemon.port'))) throw Error('Sidebar fixture already has a daemon; refusing to reuse it')
mkdirSync(data, { recursive: true })
const daemon = spawn(process.env.KYBERN_TEST_DAEMON ?? '/Applications/kybern.app/Contents/MacOS/kybernd', ['--data-dir', data, '--port', '4331'], { stdio: 'ignore' })
let client: KybernClient | undefined
let child: ReturnType<typeof Bun.spawn> | undefined
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { child?.kill(signal); daemon.kill(signal) })
try {
  const deadline = Date.now() + 30000
  while (!existsSync(path.join(data, 'daemon.port'))) {
    if (Date.now() > deadline || daemon.exitCode !== null) throw Error('Scratch daemon failed')
    await Bun.sleep(30)
  }
  const token = readFileSync(path.join(data, 'daemon.token'), 'utf8').trim()
  client = new KybernClient({ url: 'ws://127.0.0.1:4331/ws', token })
  client.connect()
  while (client.status !== 'open') { if (Date.now() > deadline) throw Error('Scratch handshake failed'); await Bun.sleep(30) }
  const db = new Database(path.join(data, 'state.sqlite'))
  const ids: string[] = []
  let turns = 0, events = 0
  try {
    db.transaction(() => {
      const project = db.query('INSERT INTO projects(id,name,path,is_git,created_at,updated_at,task_prefix) VALUES (?,?,?,0,?,?,?)')
      const thread = db.query("INSERT INTO threads(id,project_id,title,provider_kind,provider_instance,permission_mode,status,cwd,created_at,updated_at) VALUES (?,?,?,'claude-code','default','supervised','idle',?,?,?)")
      const event = db.query('INSERT INTO events(thread_id,turn_id,at,kind,payload) VALUES (?,?,?,?,?)')
      const at = '2026-10-17T09:00:00Z'
      for (let p = 0; p < 20; p++) {
        const projectId = crypto.randomUUID(), dir = path.join(data, `project-${p}`)
        mkdirSync(dir, { recursive: true })
        project.run(projectId, `Startup project ${String(p + 1).padStart(2, '0')}`, dir, at, at, `SP${p}`)
        for (let t = 0; t < 15; t++) {
          const id = crypto.randomUUID(), n = p < 3 && t < 4 ? 1000 + t * 500 : 24 + t * 2
          ids.push(id)
          thread.run(id, projectId, `Startup conversation ${p + 1}-${t + 1}`, dir, at, at)
          for (let i = 0; i < n; i++) {
            turns++
            const turn = crypto.randomUUID(), message = crypto.randomUUID(), tool = crypto.randomUUID()
            const task = { id: `process-${i}`, thread_id: id, origin_turn_id: turn, kind: 'process', status: 'completed', title: 'Run checks', started_at: at, updated_at: at, completed_at: at }
            const payloads = [
              { kind: 'turn_started', message_id: crypto.randomUUID(), message: { parts: [{ type: 'text', text: `Review startup fixture turn ${i + 1}. Preserve formatting, tool results and history.` }] } },
              { kind: 'tool_call_started', call: { id: tool, name: 'Read', input: { file_path: 'src/startup.ts' } }, origin: { kind: 'root' } },
              { kind: 'tool_call_completed', tool_call_id: tool, output: { text: 'export const startup = true;\n'.repeat(180) }, is_error: false },
              ...(i % 20 === 0 ? [{ kind: 'runtime_task_completed', task }] : []),
              { kind: 'assistant_message_completed', message_id: message, origin: { kind: 'root' }, text: `## Startup result ${i + 1}\n\nThe **formatted answer** keeps stable rows and bounded history.\n\n\x60\x60\x60typescript\nexport const ready = ${i + 1};\n\x60\x60\x60\n\n- Shell painted\n- Content loaded\n\n| Check | Result |\n| --- | --- |\n| History | Preserved |\n\n${'A realistic explanation of the change and its verification. '.repeat(8)}`, thinking: null },
              { kind: 'turn_completed', stop_reason: 'completed', usage: { input_tokens: 100, output_tokens: 100, cache_read_tokens: 0, cache_write_tokens: 0 }, cost_usd: null, duration_ms: 1000, terminal_message_id: message },
            ]
            for (const payload of payloads) { event.run(id, turn, at, payload.kind, JSON.stringify(payload)); events++ }
          }
          if (t === 0) db.query('UPDATE threads SET title=? WHERE id=?').run(`Sidebar review ${p + 1}: preserve thread navigation, tooltips, disclosure motion and drag behaviour with a long title`, id)
          if (t < 2) db.query("UPDATE threads SET pinned=1 WHERE id=?").run(id)
          db.query('UPDATE threads SET last_seq=(SELECT MAX(seq) FROM events WHERE thread_id=?) WHERE id=?').run(id, id)
        }
      }
    })()
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } finally { db.close() }
  writeFileSync(path.join(data, 'fixture.json'), JSON.stringify({ threadId: ids[3], otherId: ids[2], ids }))
  // Restore one genuinely long thread through the same saved split-state path as the app.
  writeFileSync(path.join(data, 'gpuix-ui.json'), JSON.stringify({ 'kybern.split-view.v1': { version: 1, root: { kind: 'leaf', id: 'main', threadId: ids[3] }, focusedPaneId: 'main' } }))
  console.log(JSON.stringify({ fixture: { projects: 20, threads: ids.length, longThreads: 12, turns, events, longThread: ids[3], daemonPid: daemon.pid } }))
  client.close(); client = undefined
  child = Bun.spawn(command, { env: { ...process.env, KYBERN_DATA_DIR: data, KYBERN_CLIENT_CONFIG_DIR: path.join(data, 'client'), KYBERN_GPUIX_CREDENTIALS_DIR: path.join(data, 'credentials'), KYBERN_GPUIX_ENVIRONMENT: 'local', KYBERN_GPUIX_THREAD: '', KYBERN_URL: '', KYBERN_TOKEN: '', KYBERN_STARTUP_THREAD: ids[3], KYBERN_STARTUP_OTHER_THREAD: ids[2], KYBERN_STARTUP_COLD_OTHER_THREAD: ids[17], KYBERN_STARTUP_DAEMON_PID: String(daemon.pid) }, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' })
  process.exitCode = await child.exited
} finally {
  child?.kill(); client?.close(); daemon.kill()
  if (daemon.exitCode === null && daemon.signalCode === null) await new Promise<void>(resolve => daemon.once('exit', () => resolve()))
  rmSync(data, { recursive: true, force: true })
}
