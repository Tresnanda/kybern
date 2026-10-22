/**
 * ADE-52 platform smoke test: a scratch daemon with one seeded thread, then the
 * app and the rounded-clip lab on screen, each captured to a PNG.
 *
 *   bun scripts/platform-smoke.ts --kybernd <path> --out <dir>
 *
 * Same seeding technique as perf/bench/seed.ts (RPC creates the records, SQL
 * appends synthetic provider events), without its macOS helpers; no agent runs.
 * Windows captures through the addon's `captureScreenshot` (GPUI renders the
 * window's scene to an image); Linux has no wgpu readback, so it captures the X
 * display with ImageMagick's `import` (run it under Xvfb).
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { launch } from '@gpuix/react/automation'
import { KybernClient } from '../../../packages/kybern-client/src/client.ts'

const argv = process.argv.slice(2)
const arg = (name: string, fallback?: string) => {
  const at = argv.indexOf(`--${name}`)
  const value = at >= 0 ? argv[at + 1] : fallback
  if (value === undefined) throw new Error(`--${name} is required`)
  return value
}
const out = path.resolve(arg('out'))
const kybernd = path.resolve(arg('kybernd'))
const port = Number(arg('port', '4377'))
const settle = Number(arg('settle-ms', '4000'))
const os = process.platform === 'win32' ? 'windows' : process.platform
const data = path.join(out, 'scratch')
rmSync(data, { recursive: true, force: true })
mkdirSync(path.join(data, 'project'), { recursive: true })

const daemon = spawn(kybernd, ['--data-dir', data, '--port', String(port)], { stdio: 'inherit' })
const stop = () => daemon.exitCode === null && daemon.kill()
process.on('exit', stop)
const deadline = Date.now() + 60_000
while (!existsSync(path.join(data, 'daemon.port'))) {
  if (daemon.exitCode !== null || Date.now() > deadline) throw new Error('The scratch daemon did not start')
  await Bun.sleep(50)
}
const token = readFileSync(path.join(data, 'daemon.token'), 'utf8').trim()
const client = new KybernClient(
  { url: `ws://127.0.0.1:${port}/ws`, token },
  { createSocket: (url, auth) => new WebSocket(url, { headers: { origin: 'tauri://localhost', Authorization: `Bearer ${auth}` } } as unknown as string[]) },
)
await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Connection timeout')), 15_000)
  client.onStatus((status) => status === 'open' && (clearTimeout(timer), resolve()))
  client.connect()
})
const call = client.call.bind(client) as (method: string, params: unknown) => Promise<any>
const project = await call('projects.add', { path: path.join(data, 'project'), name: 'Platform smoke' })
const provider = { kind: 'claude-code', instance: 'default' }
const threads: string[] = []
for (const title of ['Render the transcript on ' + os, 'Rounded clipping in WGSL and HLSL', 'Bun main thread or the UI thread']) {
  threads.push((await call('threads.create', { project_id: project.id, title, provider, model: 'claude-haiku-5-5' })).id)
}
client.close()

const answer = `## It draws on ${os}

The patched addon builds for this platform, and GPUI paints the **sidebar**, this *transcript* and the composer.

| Piece | Status |
| --- | --- |
| Rounded clip | ported |
| Backdrop blur | translucent fill |

- Markdown with \`inline code\`
- A fenced block below

\`\`\`rust
fn update_window<R: Send + 'static>(update: impl FnOnce(&mut View) -> R + Send + 'static) -> Result<R> {
    run_on_ui_thread(move |window, cx| window.update(cx, update))
}
\`\`\`
`
const db = new Database(path.join(data, 'state.sqlite'))
try {
  const insert = db.query('INSERT INTO events(thread_id,turn_id,at,kind,payload) VALUES (?,?,?,?,?)')
  const at = '2026-10-22T00:00:00Z'
  const id = (n: number) => `00000000-0000-4000-a000-${String(n).padStart(12, '0')}`
  const events = [
    { kind: 'turn_started', message_id: id(1), message: { parts: [{ type: 'text', text: `Show me the GPUIX client running on ${os}.` }] } },
    { kind: 'tool_call_started', call: { id: id(2), name: 'Read', input: { file_path: 'apps/gpuix/PORTING-PLATFORMS.md' } }, origin: { kind: 'root' } },
    { kind: 'tool_call_completed', tool_call_id: id(2), output: { text: '# Porting GPUIX' }, is_error: false },
    { kind: 'assistant_message_completed', message_id: id(3), origin: { kind: 'root' }, text: answer, thinking: null },
    { kind: 'turn_completed', stop_reason: 'completed', usage: { input_tokens: 1000, output_tokens: 500, cache_read_tokens: 0, cache_write_tokens: 0 }, cost_usd: null, duration_ms: 4000, terminal_message_id: id(3) },
  ]
  db.transaction(() => {
    for (const event of events) insert.run(threads[0]!, id(10), at, event.kind, JSON.stringify(event))
    db.query('UPDATE threads SET last_seq=(SELECT MAX(seq) FROM events WHERE thread_id=?),updated_at=? WHERE id=?').run(threads[0]!, at, threads[0]!)
  })()
} finally {
  db.close()
}

async function capture(app: Awaited<ReturnType<typeof launch>>, file: string) {
  if (process.platform === 'linux') execFileSync('import', ['-window', 'root', file])
  else await app.screenshot({ path: file })
  console.log(`[smoke] wrote ${file}`)
}

async function shoot(entry: string, ready: string, file: string, env: Record<string, string>, expectText?: string) {
  const app = await launch({ command: process.execPath, args: [entry], env: { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: 'dark', ...env } })
  try {
    await app.getByTestId(ready).waitFor({ timeoutMs: 90_000 })
    // A software-rendered first frame can starve the app's 750 ms daemon probe on a
    // small runner; the app then offers Reconnect, which is what a user would press.
    for (let attempt = 0; expectText && attempt < 4; attempt++) {
      try {
        await app.getByText(expectText).waitFor({ timeoutMs: 20_000 })
        break
      } catch {
        console.log(`[smoke] "${expectText}" not on screen yet; pressing Reconnect`)
        await app.getByText('Reconnect').click().catch(() => {})
      }
    }
    await Bun.sleep(settle)
    await capture(app, path.join(out, file))
  } finally {
    await app.close().catch(() => {})
  }
}

const app = path.join(import.meta.dir, '../src/main.tsx')
const scratchEnv = {
  KYBERN_DATA_DIR: data,
  KYBERND: kybernd,
  KYBERN_CLIENT_CONFIG_DIR: path.join(data, 'client'),
  KYBERN_GPUIX_CREDENTIALS_DIR: path.join(data, 'credentials'),
  KYBERN_GPUIX_ENVIRONMENT: 'local',
  KYBERN_URL: '',
  KYBERN_TOKEN: '',
  KYBERN_GPUIX_THREAD: threads[0]!,
}
// The lab first: on a cold runner the first launch (Bun's transpile cache, Mesa's
// shader cache) can starve the app's daemon probe.
await shoot(path.join(import.meta.dir, '../native/clip-lab.tsx'), 'ready', `${os}-clip.png`, {})
await shoot(app, 'app-ready', `${os}-app.png`, scratchEnv, `Show me the GPUIX client running on ${os}.`)
stop()
process.exit(0)
