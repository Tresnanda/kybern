/** Enter → user bubble latency in the real GPUIX app (lane chatfix2, item 4).
 *
 *   bun perf/send/run.ts <label> [--scenarios warm,resume,large,queued] [--reps 6]
 *
 * A scratch daemon (this checkout's `target/debug/kybernd`, or SEND_DAEMON) on port 4375 runs threads on the stand-in
 * Claude CLI (`fake-claude.ts`, no model): a warm session, an idle session that was released and must be resumed
 * (FAKE_CLAUDE_START_MS spawn delay), a project with a multi-GB untracked folder, a queued send while a turn runs, and
 * sends while another thread's worktree removal or a long thread's full read holds the daemon (busy-worktree, busy-store).
 * Each rep fills the composer, measures a keystroke echo (one frame of input → paint, the reference), then presses
 * Enter and polls the painted window until the message shows as a user bubble (or as a queued row) and the composer
 * is empty. Results append to previews/chatfix2/send/results.jsonl.
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import path from 'node:path'
import { connect } from '../../visual/fixture.ts'
import { launchFixture } from '../../src/requests/harness.ts'
import { lease } from '../bench/lease.ts'
import { readdirSync } from 'node:fs'
const buildMarkers = () => readdirSync('/tmp').filter(n => n.startsWith('kybern-gpuix-native-build.'))

const DATA = '/Users/mymac/projects/ade-gpuix-scratch/chatfix2'
const PORT = 4375
const OUT = '/Users/mymac/projects/ade/previews/chatfix2/send'
const root = path.resolve(import.meta.dir, '../..')
const daemonBin = process.env.SEND_DAEMON ?? path.resolve(root, '../../target/debug/kybernd')
const argv = process.argv.slice(2)
const flag = (name: string, fallback: string) => { const i = argv.indexOf(name); if (i < 0) return fallback; const v = argv[i + 1]!; argv.splice(i, 2); return v }
const scenarios = flag('--scenarios', 'warm,resume,large,queued').split(',')
const reps = Number(flag('--reps', '6'))
const label = argv[0] ?? 'run'
mkdirSync(OUT, { recursive: true }); mkdirSync(DATA, { recursive: true })

const fake = path.join(import.meta.dir, 'fake-claude.ts')
chmodSync(fake, 0o755)
writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ providers: { 'claude-code': { binary: fake, env: { FAKE_CLAUDE_TURN_MS: '2500', FAKE_CLAUDE_START_MS: '900' } } } }, null, 2))
const daemon = spawn(daemonBin, ['--data-dir', DATA, '--port', String(PORT)], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, KYBERN_URL: '', KYBERN_TOKEN: '', RUST_LOG: process.env.RUST_LOG ?? 'warn' } })
let daemonLog = ''
daemon.stderr!.on('data', c => { daemonLog = (daemonLog + String(c)).slice(-20000) })
const stop = () => { try { daemon.kill() } catch {} }
process.on('exit', stop)
for (let i = 0; i < 300 && !existsSync(path.join(DATA, 'daemon.port')); i++) await Bun.sleep(50)
const token = readFileSync(path.join(DATA, 'daemon.token'), 'utf8').trim()
await Bun.sleep(300)
const client = await connect({ daemonPid: daemon.pid!, port: PORT, token, seeded: false } as never)
type Call = (method: string, params: unknown) => Promise<any>
const call: Call = (m, p) => (client as unknown as { call: Call }).call(m, p)

function repo(name: string, untrackedGiB = 0) {
  const folder = path.join(DATA, 'projects', name)
  if (existsSync(path.join(folder, '.git'))) return folder
  mkdirSync(path.join(folder, 'src'), { recursive: true })
  for (let f = 0; f < 200; f++) writeFileSync(path.join(folder, 'src', `m${f}.ts`), `export const v${f} = ${f}\n`)
  execFileSync('git', ['init', '-q', folder]); execFileSync('git', ['-C', folder, 'add', '.'])
  execFileSync('git', ['-C', folder, '-c', 'user.name=Send fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'])
  if (untrackedGiB) {
    // Sparse files: gigabytes for Git and the checkpoint to walk and hash, almost no disk.
    const big = path.join(folder, 'recordings'); mkdirSync(big, { recursive: true })
    for (let f = 0; f < untrackedGiB * 64; f++) execFileSync('mkfile', ['-n', '16m', path.join(big, `take-${f}.mov`)])
  }
  return folder
}
async function project(name: string, untrackedGiB = 0) {
  const folder = repo(name, untrackedGiB)
  const listed = (await call('projects.list', {})).projects.find((p: { path: string }) => p.path === folder)
  return listed ?? (await call('projects.add', { path: folder }))
}
const provider = { kind: 'claude-code', instance: 'default' }
async function idle(threadId: string) {
  for (let i = 0; i < 400; i++) { const t = (await call('threads.get', { thread_id: threadId })).thread; if (t.status === 'idle') return; await Bun.sleep(50) }
  throw Error(`thread ${threadId} never went idle`)
}
async function thread(projectId: string, title: string) {
  const t = await call('threads.create', { project_id: projectId, provider, pin_account: false, permission_mode: 'supervised', use_worktree: false, message: { parts: [{ type: 'text', text: `seed ${title}` }] } })
  await idle(t.id)
  return t.id as string
}
const small = await project('small')
const large = await project('large', Number(process.env.SEND_LARGE_GIB ?? 2))
// Contention, the "sometimes" in the report: another thread's 20k-file worktree removal (daemon-wide workspace lock), or
// a full read of a 47k-event / ~230 MB thread (the store connection), runs while Enter is pressed.
const wide = await (async () => {
  const folder = path.join(DATA, 'projects', 'wide')
  if (!existsSync(path.join(folder, '.git'))) {
    for (let d = 0; d < 100; d++) { mkdirSync(path.join(folder, `pkg${d}`), { recursive: true }); for (let f = 0; f < 200; f++) writeFileSync(path.join(folder, `pkg${d}`, `f${f}.ts`), `export const v = ${f}\n`) }
    execFileSync('git', ['init', '-q', folder]); execFileSync('git', ['-C', folder, 'add', '.'])
    execFileSync('git', ['-C', folder, '-c', 'user.name=Send fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'])
  }
  return (await call('projects.list', {})).projects.find((p: { path: string }) => p.path === folder) ?? call('projects.add', { path: folder })
})()
async function heavyThread() {
  const id = (await call('threads.create', { project_id: small.id, provider, pin_account: false, permission_mode: 'supervised', use_worktree: false, message: { parts: [{ type: 'text', text: 'heavy seed' }] } })).id as string
  await idle(id)
  const { Database } = await import('bun:sqlite')
  const db = new Database(path.join(DATA, 'state.sqlite'))
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
      ]) insert.run(id, turn, at, e.kind, JSON.stringify(e))
    }
  })()
  db.close()
  return id
}
const contention: Record<string, () => Promise<() => Promise<unknown>>> = {
  'busy-worktree': async () => { const t = await call('threads.create', { project_id: wide.id, provider, pin_account: false, permission_mode: 'supervised', use_worktree: true, message: { parts: [{ type: 'text', text: 'worktree seed' }] } }); await idle(t.id); return () => call('threads.worktree.remove', { thread_id: t.id, force: true }) },
  'busy-store': async () => { const heavy = await heavyThread(); return () => call('threads.regenerateTitle', { thread_id: heavy }) },
}

type Row = { scenario: string; rep: number; buildMarkers: number; echoMs: number; bubbleMs: number; clearedMs: number; frames: number }
const rows: Row[] = []
for (const scenario of scenarios) {
  const threadId = await thread(scenario === 'large' ? large.id : small.id, scenario)
  const scratch = path.join(DATA, 'client', `${label}-${scenario}`); rmSync(scratch, { recursive: true, force: true }); mkdirSync(scratch, { recursive: true })
  const release = await lease()
  const markers = buildMarkers()
  const f = await launchFixture(path.join(root, 'src/main.tsx'), {
    KYBERN_DATA_DIR: DATA, KYBERN_URL: `ws://127.0.0.1:${PORT}/ws`, KYBERN_TOKEN: token, KYBERN_CLIENT_CONFIG_DIR: scratch, KYBERN_GPUIX_CREDENTIALS_DIR: path.join(scratch, 'credentials'),
    KYBERN_GPUIX_THREAD: threadId, GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: process.env.KYBERN_APPEARANCE ?? 'dark',
    NAPI_RS_NATIVE_LIBRARY_PATH: process.env.NAPI_RS_NATIVE_LIBRARY_PATH ?? path.join(root, 'native/build/gpuix-native.darwin-arm64.node'),
  })
  try {
    const app = f.app, composer = app.getByTestId('composer')
    await composer.waitFor({ timeout: 30000 } as never)
    await Bun.sleep(1500)
    const painted = async () => String((await app.call('getPaintedText', {})).text)
    const cleared = async () => (await app.getByTestId('composer-placeholder').count()) > 0
    for (let rep = 1; rep <= reps; rep++) {
      if (scenario === 'resume') { await idle(threadId); await call('threads.release', { thread_id: threadId }).catch(() => {}); await Bun.sleep(400) }
      else if (scenario === 'queued') { await idle(threadId); await call('threads.send', { thread_id: threadId, message: { parts: [{ type: 'text', text: `running turn ${rep}` }] } }); await Bun.sleep(600) }
      else await idle(threadId)
      const busy = contention[scenario] ? await contention[scenario]!() : null
      const text = `probe ${scenario} ${rep} ${Math.random().toString(36).slice(2, 8)}`
      await composer.fill(text)
      for (let i = 0; i < 100 && !(await painted()).includes(text); i++) await Bun.sleep(10)
      // Reference: one keystroke from automation to paint.
      let t0 = performance.now()
      await composer.press('x')
      while (!(await painted()).includes(text + 'x')) await Bun.sleep(1)
      const echoMs = performance.now() - t0
      await composer.press('backspace')
      for (let i = 0; i < 100 && (await painted()).includes(text + 'x'); i++) await Bun.sleep(5)
      await Bun.sleep(150)
      const background = busy?.().catch(() => {})
      if (busy) await Bun.sleep(40)
      t0 = performance.now()
      await composer.press('enter')
      let bubbleMs = NaN, clearedMs = NaN
      for (const deadline = t0 + 15000; performance.now() < deadline && (Number.isNaN(bubbleMs) || Number.isNaN(clearedMs));) {
        const shown = await painted(), now = performance.now() - t0
        // Sent: the composer no longer holds it; shown: it is painted (bubble or queued row).
        const empty = await cleared()
        if (Number.isNaN(clearedMs) && empty) clearedMs = now
        // With the composer empty, the painted text can only be the transcript bubble (or the queued row).
        if (Number.isNaN(bubbleMs) && empty && shown.includes(text)) bubbleMs = now
        await Bun.sleep(1)
      }
      await background
      const row = { scenario, rep, buildMarkers: [...markers, ...buildMarkers()].length, echoMs: Math.round(echoMs * 10) / 10, bubbleMs: Math.round(bubbleMs * 10) / 10, clearedMs: Math.round(clearedMs * 10) / 10, frames: Math.max(0, Math.round((bubbleMs - echoMs) / 16.7)) }
      rows.push(row); console.log(JSON.stringify(row))
      appendFileSync(path.join(OUT, 'results.jsonl'), JSON.stringify({ label, at: new Date().toISOString(), ...row }) + '\n')
      if (rep === reps) await app.screenshot({ path: path.join(OUT, `${label}-${scenario}.png`) })
      await idle(threadId).catch(() => {})
      if (scenario === 'queued') { for (let i = 0; i < 200; i++) { const q = await call('queue.list', { thread_id: threadId }); if (!q.messages.length) break; await Bun.sleep(50) } await idle(threadId) }
    }
  } finally { await f.close(); release() }
}
const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]! }
for (const scenario of scenarios) {
  const r = rows.filter(x => x.scenario === scenario)
  console.log(`${label} ${scenario}: echo median ${median(r.map(x => x.echoMs)).toFixed(1)} ms, bubble median ${median(r.map(x => x.bubbleMs)).toFixed(1)} ms (max ${Math.max(...r.map(x => x.bubbleMs)).toFixed(1)}), cleared median ${median(r.map(x => x.clearedMs)).toFixed(1)} ms`)
}
client.close?.()
stop()
process.exit(0)
