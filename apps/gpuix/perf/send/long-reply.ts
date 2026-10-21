/** A 40k-character final reply rendered whole (item 2): open time, scroll frame intervals, CPU and footprint.
 *
 *   bun perf/send/long-reply.ts <label> [--runs 3]
 *
 * Own scratch daemon (port 4378) and one thread whose settled reply is ~40k characters of mixed paragraphs, lists,
 * headings and tables. Each run launches the full app on that thread (hidden test display, shared UI lease), times
 * launch → reply tail painted, then wheels up and down through the reply (60 events each way) and reports native
 * frame intervals (p50/p95/p99, frames over 16.7/33 ms), process CPU and physical footprint. Appends to
 * previews/chatfix2/send/long-reply.jsonl.
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { connect } from '../../visual/fixture.ts'
import { launchFixture } from '../../src/requests/harness.ts'
import { lease } from '../bench/lease.ts'
import { cpuSeconds, footprintMiB } from '../../scripts/idle-metrics.ts'

const DATA = '/Users/mymac/projects/ade-gpuix-scratch/chatfix2-long'
const PORT = 4378
const OUT = '/Users/mymac/projects/ade/previews/chatfix2/send'
const root = path.resolve(import.meta.dir, '../..')
const argv = process.argv.slice(2)
const runs = Number(argv.includes('--runs') ? argv[argv.indexOf('--runs') + 1] : 3)
const label = argv[0] ?? 'run'
rmSync(DATA, { recursive: true, force: true }); mkdirSync(DATA, { recursive: true }); mkdirSync(OUT, { recursive: true })
const fake = path.join(import.meta.dir, 'fake-claude.ts'); chmodSync(fake, 0o755)
writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ providers: { 'claude-code': { binary: fake, env: { FAKE_CLAUDE_TURN_MS: '100' } } } }))
const daemon = spawn(process.env.SEND_DAEMON ?? path.resolve(root, '../../target/debug/kybernd'), ['--data-dir', DATA, '--port', String(PORT)], { stdio: 'ignore', env: { ...process.env, KYBERN_URL: '', KYBERN_TOKEN: '' } })
process.on('exit', () => { try { daemon.kill() } catch {} })
for (let i = 0; i < 300 && !existsSync(path.join(DATA, 'daemon.port')); i++) await Bun.sleep(50)
await Bun.sleep(300)
const token = readFileSync(path.join(DATA, 'daemon.token'), 'utf8').trim()
const client = await connect({ daemonPid: daemon.pid!, port: PORT, token, seeded: false } as never) as unknown as { call: (m: string, p: unknown) => Promise<any> }
const folder = path.join(DATA, 'project'); mkdirSync(folder, { recursive: true }); execFileSync('git', ['init', '-q', folder])
const project = await client.call('projects.add', { path: folder })
const thread = await client.call('threads.create', { project_id: project.id, provider: { kind: 'claude-code', instance: 'default' }, pin_account: false, permission_mode: 'supervised', use_worktree: false, message: { parts: [{ type: 'text', text: 'Long reply' }] } })
for (let i = 0; i < 200 && (await client.call('threads.get', { thread_id: thread.id })).thread.status !== 'idle'; i++) await Bun.sleep(25)
const sections: string[] = []
for (let i = 0; sections.join('\n\n').length < 40000; i++) sections.push(i % 6 === 2 ? `| Step | Result |\n|---|---|\n| ${i} | ok |\n| ${i + 1} | ok |` : i % 4 === 1 ? `### Part ${i}\n\n- point one for part ${i}\n- point two` : `Paragraph ${i}. ${'The fix keeps every block whole and bounded. '.repeat(8)}`)
const reply = `${sections.join('\n\n')}\n\nEnd of the long reply.`
{
  const db = new Database(path.join(DATA, 'state.sqlite')), turn = crypto.randomUUID(), message = crypto.randomUUID(), at = new Date().toISOString()
  const insert = db.query('INSERT INTO events(thread_id,turn_id,at,kind,payload) VALUES (?,?,?,?,?)')
  for (const e of [{ kind: 'turn_started', message_id: crypto.randomUUID(), message: { parts: [{ type: 'text', text: 'Write the report.' }] } },
    { kind: 'assistant_message_completed', message_id: message, origin: { kind: 'root' }, text: reply, thinking: null },
    { kind: 'turn_completed', stop_reason: 'completed', usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0 }, cost_usd: null, duration_ms: 1, terminal_message_id: message }])
    insert.run(thread.id, turn, at, e.kind, JSON.stringify(e))
  db.query('UPDATE threads SET last_seq=(SELECT MAX(seq) FROM events WHERE thread_id=?) WHERE id=?').run(thread.id, thread.id)
  db.close()
}
const pct = (v: number[], p: number) => { const s = [...v].sort((a, b) => a - b); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))]! * 10) / 10 : NaN }
const markers = () => readdirSync('/tmp').filter(n => n.startsWith('kybern-gpuix-native-build.')).length
for (let run = 1; run <= runs; run++) {
  const release = await lease()
  const scratch = path.join(DATA, 'client', `${label}-${run}`); mkdirSync(scratch, { recursive: true })
  const before = markers(), t0 = performance.now()
  const f = await launchFixture(path.join(root, 'src/main.tsx'), {
    KYBERN_DATA_DIR: DATA, KYBERN_URL: `ws://127.0.0.1:${PORT}/ws`, KYBERN_TOKEN: token, KYBERN_CLIENT_CONFIG_DIR: scratch, KYBERN_GPUIX_CREDENTIALS_DIR: path.join(scratch, 'credentials'),
    KYBERN_GPUIX_THREAD: thread.id, GPUIX_BACKGROUND: '1', KYBERN_FRAME_TIMES: '1', KYBERN_APPEARANCE: 'dark', KYBERN_WINDOW_SIZE: '1280x900',
    NAPI_RS_NATIVE_LIBRARY_PATH: process.env.NAPI_RS_NATIVE_LIBRARY_PATH ?? path.join(root, 'native/build/gpuix-native.darwin-arm64.node'),
  })
  try {
    const app = f.app, painted = async () => String((await app.call('getPaintedText', {})).text)
    for (let i = 0; i < 1500 && !(await painted()).includes('End of the long reply'); i++) await Bun.sleep(20)
    const openMs = performance.now() - t0
    await Bun.sleep(2000)
    const cpu0 = cpuSeconds(f.pid), frames0 = f.frameTimes().length, s0 = performance.now()
    for (const direction of [-1, 1]) for (let i = 0; i < 60; i++) { await app.mouse.wheel({ x: 800, y: 420 }, 0, direction * 120); await Bun.sleep(16) }
    await Bun.sleep(500)
    const seconds = (performance.now() - s0) / 1000
    const times = f.frameTimes().slice(frames0), gaps = times.slice(1).map((t, i) => t - times[i]!)
    const row = { label, run, openMs: Math.round(openMs), frames: times.length, p50: pct(gaps, 0.5), p95: pct(gaps, 0.95), p99: pct(gaps, 0.99), over16: gaps.filter(g => g > 16.7).length, over33: gaps.filter(g => g > 33).length,
      cpuPercent: Math.round(((cpuSeconds(f.pid) - cpu0) / seconds) * 1000) / 10, footprintMiB: Math.round(footprintMiB(f.pid)), buildMarkers: before + markers() }
    console.log(JSON.stringify(row)); appendFileSync(path.join(OUT, 'long-reply.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n')
    if (run === runs) await app.screenshot({ path: path.join(OUT, `long-reply-${label}.png`) })
  } finally { await f.close(); release() }
}
daemon.kill(); rmSync(DATA, { recursive: true, force: true })
process.exit(0)
