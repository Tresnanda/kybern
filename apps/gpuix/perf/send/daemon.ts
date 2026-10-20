/** Daemon side of item 4: `threads.send` → `turn_started` latency, without a UI.
 *
 *   bun perf/send/daemon.ts <label> [--reps 8]
 *
 * Own scratch daemon (port 4376, data `…/chatfix2-daemon`) on the stand-in Claude CLI. Scenarios: a warm session, a
 * released session (resume on send), a project with a multi-GB untracked folder, a send while another thread's slow
 * RPC holds the daemon (a checkpoint-sized `git` walk via `threads.diff` on the large repo), and a send while a
 * worktree removal runs in another thread. Reports the RPC answer and the event arrival, in ms.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import path from 'node:path'
import { connect } from '../../visual/fixture.ts'

const DATA = '/Users/mymac/projects/ade-gpuix-scratch/chatfix2-daemon'
const PORT = 4376
const OUT = '/Users/mymac/projects/ade/previews/chatfix2/send'
const root = path.resolve(import.meta.dir, '../..')
const daemonBin = process.env.SEND_DAEMON ?? path.resolve(root, '../../target/debug/kybernd')
const argv = process.argv.slice(2)
const reps = Number(argv.includes('--reps') ? argv[argv.indexOf('--reps') + 1] : 8)
const label = argv[0] ?? 'run'
mkdirSync(OUT, { recursive: true }); mkdirSync(DATA, { recursive: true })
const fake = path.join(import.meta.dir, 'fake-claude.ts')
chmodSync(fake, 0o755)
writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ providers: { 'claude-code': { binary: fake, env: { FAKE_CLAUDE_TURN_MS: '300', FAKE_CLAUDE_START_MS: '900' } } } }, null, 2))
rmSync(path.join(DATA, 'daemon.port'), { force: true })
const daemon = spawn(daemonBin, ['--data-dir', DATA, '--port', String(PORT)], { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, KYBERN_URL: '', KYBERN_TOKEN: '', RUST_LOG: 'warn' } })
process.on('exit', () => { try { daemon.kill() } catch {} })
for (let i = 0; i < 300 && !existsSync(path.join(DATA, 'daemon.port')); i++) await Bun.sleep(50)
await Bun.sleep(300)
const client = await connect({ daemonPid: daemon.pid!, port: PORT, token: readFileSync(path.join(DATA, 'daemon.token'), 'utf8').trim(), seeded: false } as never) as unknown as {
  call: (m: string, p: unknown) => Promise<any>; subscribeEvents: (p: object, h: (e: any) => void) => unknown
}
const started = new Map<string, number>()
client.subscribeEvents({}, (e: { kind?: string; message_id?: string }) => {
  if (e.kind === 'turn_started' && e.message_id) started.set(e.message_id, performance.now())
})

function repo(name: string, sparseGiB = 0) {
  const folder = path.join(DATA, 'projects', name)
  if (existsSync(path.join(folder, '.git'))) return folder
  mkdirSync(path.join(folder, 'src'), { recursive: true })
  for (let f = 0; f < 200; f++) writeFileSync(path.join(folder, 'src', `m${f}.ts`), `export const v${f} = ${f}\n`)
  execFileSync('git', ['init', '-q', folder]); execFileSync('git', ['-C', folder, 'add', '.'])
  execFileSync('git', ['-C', folder, '-c', 'user.name=Send fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'])
  if (sparseGiB) { const big = path.join(folder, 'recordings'); mkdirSync(big, { recursive: true }); for (let f = 0; f < sparseGiB * 64; f++) execFileSync('mkfile', ['-n', '16m', path.join(big, `take-${f}.mov`)]) }
  return folder
}
const project = async (name: string, gib = 0) => { const folder = repo(name, gib); return (await client.call('projects.list', {})).projects.find((p: { path: string }) => p.path === folder) ?? client.call('projects.add', { path: folder }) }
const provider = { kind: 'claude-code', instance: 'default' }
const idle = async (id: string) => { for (let i = 0; i < 600; i++) { if ((await client.call('threads.get', { thread_id: id })).thread.status === 'idle') return; await Bun.sleep(25) } throw Error('never idle') }
const thread = async (projectId: string, worktree = false) => { const t = await client.call('threads.create', { project_id: projectId, provider, pin_account: false, permission_mode: 'supervised', use_worktree: worktree, message: { parts: [{ type: 'text', text: 'seed' }] } }); await idle(t.id); return t.id as string }
const small = await project('small'), large = await project('large', Number(process.env.SEND_LARGE_GIB ?? 2))
const wide = await (async () => {
  const folder = path.join(DATA, 'projects', 'wide')
  if (!existsSync(path.join(folder, '.git'))) {
    for (let d = 0; d < 100; d++) { mkdirSync(path.join(folder, `pkg${d}`), { recursive: true }); for (let f = 0; f < 200; f++) writeFileSync(path.join(folder, `pkg${d}`, `f${f}.ts`), `export const v = ${f}\n`) }
    execFileSync('git', ['init', '-q', folder]); execFileSync('git', ['-C', folder, 'add', '.'])
    execFileSync('git', ['-C', folder, '-c', 'user.name=Send fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'])
  }
  return (await client.call('projects.list', {})).projects.find((p: { path: string }) => p.path === folder) ?? client.call('projects.add', { path: folder })
})()
const warm = await thread(small.id), resume = await thread(small.id), big = await thread(large.id), other = await thread(large.id)
// A long thread at the size of the user's biggest (47k events, ~230 MB of payloads), appended with SQL like perf/bench/seed.ts.
const heavy = await thread(small.id)
{
  const { Database } = await import('bun:sqlite')
  const db = new Database(path.join(DATA, 'state.sqlite'))
  const have = (db.query('SELECT count(*) AS n FROM events WHERE thread_id=?').get(heavy) as { n: number }).n
  if (have < 1000) {
    const insert = db.query('INSERT INTO events(thread_id,turn_id,at,kind,payload) VALUES (?,?,?,?,?)')
    const filler = 'Lorem ipsum dolor sit amet, preserve formatted output and reading position. '.repeat(64)
    db.transaction(() => {
      for (let t = 0; t < 9500; t++) {
        const turn = crypto.randomUUID(), at = new Date(Date.UTC(2026, 9, 1, 0, 0, t)).toISOString(), msg = crypto.randomUUID(), tool = crypto.randomUUID()
        for (const e of [
          { kind: 'turn_started', message_id: crypto.randomUUID(), message: { parts: [{ type: 'text', text: `Prompt ${t}` }] } },
          { kind: 'tool_call_started', call: { id: tool, name: 'Read', input: { file_path: 'src/view.ts' } }, origin: { kind: 'root' } },
          { kind: 'tool_call_completed', tool_call_id: tool, output: { text: filler }, is_error: false },
          { kind: 'assistant_message_completed', message_id: msg, origin: { kind: 'root' }, text: filler, thinking: null },
          { kind: 'turn_completed', stop_reason: 'completed', usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0 }, cost_usd: null, duration_ms: 1, terminal_message_id: msg },
        ]) insert.run(heavy, turn, at, e.kind, JSON.stringify(e))
      }
    })()
    db.query('UPDATE threads SET last_seq=(SELECT MAX(seq) FROM events) WHERE id=?').run(heavy)
  }
  db.close()
}

async function measure(threadId: string, during?: () => Promise<unknown>) {
  await idle(threadId)
  const id = crypto.randomUUID()
  const background = during?.().catch(() => {})
  if (during) await Bun.sleep(30)
  const t0 = performance.now()
  await client.call('threads.send', { thread_id: threadId, message: { parts: [{ type: 'text', text: `probe ${id}` }] }, message_id: id })
  const rpc = performance.now() - t0
  for (let i = 0; i < 2000 && !started.has(id); i++) await Bun.sleep(1)
  const event = (started.get(id) ?? NaN) - t0
  await background
  await idle(threadId)
  return { rpc: Math.round(rpc * 10) / 10, event: Math.round(event * 10) / 10 }
}
const scenarios: Record<string, () => Promise<{ rpc: number; event: number }>> = {
  warm: () => measure(warm),
  resume: async () => { await client.call('threads.release', { thread_id: resume }); await Bun.sleep(200); return measure(resume) },
  large: () => measure(big),
  'busy-daemon': () => measure(warm, () => Promise.all([client.call('threads.diff', { thread_id: other }), client.call('threads.list', {}), client.call('git.status', { project_id: large.id })])),
  // Sending in the long thread itself, and in a small one while the long one is opened (its first page and title).
  'heavy-thread': () => measure(heavy),
  // A worktree removal in another thread (git status + delete of a 20k-file checkout) holds the daemon-wide workspace lock.
  'worktree-remove': async () => { const t = await thread(wide.id, true); return measure(warm, () => client.call('threads.worktree.remove', { thread_id: t, force: true })) },
  'heavy-open': () => measure(warm, () => client.call('threads.get', { thread_id: heavy })),
  'heavy-title': () => measure(warm, () => client.call('threads.regenerateTitle', { thread_id: heavy })),
}
const results: Record<string, { rpc: number; event: number }[]> = {}
const only = process.env.SEND_ONLY?.split(',')
for (const [name, run] of Object.entries(scenarios).filter(([n]) => !only || only.includes(n))) {
  results[name] = []
  for (let i = 0; i < reps; i++) { const r = await run(); results[name]!.push(r); appendFileSync(path.join(OUT, 'daemon.jsonl'), JSON.stringify({ label, scenario: name, ...r }) + '\n') }
  const sorted = (k: 'rpc' | 'event') => results[name]!.map(r => r[k]).sort((a, b) => a - b)
  console.log(`${label} ${name}: rpc median ${sorted('rpc')[reps >> 1]} max ${sorted('rpc').at(-1)} · turn_started median ${sorted('event')[reps >> 1]} max ${sorted('event').at(-1)} ms`)
}
daemon.kill()
process.exit(0)
