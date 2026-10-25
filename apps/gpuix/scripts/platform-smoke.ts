/**
 * Platform smoke test (ADE-52, extended by WP7): a scratch daemon with one seeded
 * thread, then the app and the rounded-clip lab on screen, each captured to a PNG
 * and asserted.
 *
 *   bun scripts/platform-smoke.ts --kybernd <path> --out <dir> [--data <scratch dir>] [--port 4377] [--only app|lab] [--capture none]
 *
 * Same seeding technique as perf/bench/seed.ts (RPC creates the records, SQL
 * appends synthetic provider events), without its macOS helpers; no agent runs.
 * Captures and the launch go through `native/check-harness.ts` (the addon's
 * screenshot, or the X server on Linux when the addon cannot). Assertions tolerate
 * software rendering: structure (test ids, bounds, painted text) first, then
 * colours within `tolerance` and regions that must hold painted pixels.
 *
 * App: the sidebar lists the three threads, the transcript paints the Markdown
 * answer (heading, table, inline code, the highlighted block) and the composer is
 * on screen, with a dark backdrop. Lab: the quad tile's centre is red and its
 * corner is the frame colour (rounded) or, off macOS, red with `KYBERN_ROUNDED_CLIP=0` (the square
 * "before" look), so the two runs prove the clip switch on the platform's shader.
 *
 * Under a headless Wayland compositor (WP1) there is nothing to grab: `--capture none`
 * still requires both windows to come up and the seeded message to be painted
 * (automation tree), and writes no PNGs or pixel assertions.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { assertPainted, capture, launch, near, platform, pngPixels, step, tolerance, type Fixture } from '../native/check-harness.ts'
import { waitForPainted } from '../src/requests/harness.ts'
import assert from 'node:assert/strict'
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
const captureMode = arg('capture', 'png')
const os = process.platform === 'win32' ? 'windows' : process.platform
// The scratch daemon's data. Keep it out of `--out` when that folder is uploaded: it holds sockets.
const data = path.resolve(arg('data', path.join(out, 'scratch')))
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

const painted = async (f: Fixture) => (await f.app.call('getPaintedText', {})).text.join('\n')

async function shoot(entry: string, ready: string, file: string, env: Record<string, string>, verify: (f: Fixture, png: ReturnType<typeof pngPixels>) => Promise<void>, expectText?: string) {
  const f = await launch(entry, { KYBERN_APPEARANCE: 'dark', ...env })
  try {
    await f.app.getByTestId(ready).waitFor({ timeoutMs: 90_000 })
    // A software-rendered first frame can starve the app's 750 ms daemon probe on a
    // small runner; the app then offers Reconnect, which is what a user would press.
    let shown = !expectText
    for (let attempt = 0; expectText && attempt < 4; attempt++) {
      try {
        await waitForPainted(f.app, expectText, 20_000)
        shown = true
        break
      } catch {
        console.log(`[smoke] "${expectText}" not on screen yet; pressing Reconnect`)
        await f.app.getByText('Reconnect').click().catch(() => {})
      }
    }
    if (captureMode === 'none') {
      // Without a PNG the painted text is the only evidence the transcript drew.
      if (!shown) throw new Error(`"${expectText}" never appeared on screen`)
      console.log(`[smoke] on screen (no capture): ${file}`)
      return
    }
    await Bun.sleep(settle)
    const shot = await capture(f, path.join(out, file))
    console.log(`[smoke] wrote ${shot}`)
    await verify(f, pngPixels(shot))
  } catch (error) {
    console.error(f.diagnostics())
    throw error
  } finally {
    await f.close().catch(() => {})
  }
}

const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : undefined
const roundedClip = process.env.KYBERN_ROUNDED_CLIP !== '0'
const RED = [0xe8, 0x4c, 0x42]

const verifyLab = async (f: Fixture, png: ReturnType<typeof pngPixels>) => {
  const scale = png.width / (await f.app.getByTestId('ready').bounds()).width
  const reference = await f.app.getByTestId('frame-reference').bounds()
  const frame = png.at((reference.x + 5) * scale, (reference.y + 5) * scale)
  const quad = await f.app.getByTestId('quad').bounds()
  await step('lab: the quad tile paints', () => assert.ok(near(png.at((quad.x + quad.width / 2) * scale, (quad.y + quad.height / 2) * scale), RED), 'the quad tile centre is red'))
  await step(`lab: the quad corner is ${roundedClip ? 'rounded away' : 'square (clip off)'}`, () => {
    const corner = png.at((quad.x + 1) * scale, (quad.y + 1) * scale)
    if (roundedClip) assert.ok(near(corner, frame), `rounded clip: the corner shows the frame colour, got ${corner}`)
    // The switch lives in the wgpu and Direct3D renderers; the macOS addon has no such variable, so there is no "before" look to assert.
    else if (platform === 'macos') console.log('[smoke] KYBERN_ROUNDED_CLIP=0 has no effect on macOS; the square corner is not asserted')
    else assert.ok(near(corner, RED), `KYBERN_ROUNDED_CLIP=0: the corner is square and red, got ${corner}`)
  })
}

const verifyApp = async (f: Fixture, png: ReturnType<typeof pngPixels>) => {
  const root = await f.app.getByTestId('app-ready').bounds()
  const scale = png.width / root.width
  await step('app: the sidebar lists the seeded threads', async () => {
    assert.equal(await f.app.getByTestId('thread-list').count(), 1, 'the thread list')
    for (const id of threads) assert.equal(await f.app.getByTestId(`thread-${id}`).count(), 1, `thread row ${id}`)
    const list = await f.app.getByTestId('thread-list').bounds()
    assert.ok(list.width > 120 && list.height > 80, `thread list is ${list.width}x${list.height}`)
    assertPainted(png, scale, list, 'sidebar')
  })
  await step('app: the transcript paints Markdown and code', async () => {
    const text = await painted(f)
    for (const piece of [`It draws on ${os}`, 'Rounded clip', 'Backdrop blur', 'inline code', 'update_window']) assert.ok(text.includes(piece), `painted text lacks "${piece}"`)
    const sidebar = await f.app.getByTestId('thread-list').bounds()
    assertPainted(png, scale, { x: sidebar.x + sidebar.width + 24, y: root.y + 60, width: root.width - sidebar.width - 48, height: Math.min(300, root.height - 260) }, 'transcript')
  })
  await step('app: the composer is on screen', async () => {
    const composer = await f.app.getByTestId('composer').bounds()
    assert.ok(composer.width > 200 && composer.height > 20, `composer is ${composer.width}x${composer.height}`)
    assert.ok(composer.y + composer.height <= root.y + root.height + 1 && composer.x >= root.x, 'the composer sits inside the window')
    assertPainted(png, scale, composer, 'composer', 4)
  })
  await step('app: dark appearance', () => {
    const corner = png.at(root.x * scale + 3, (root.y + root.height / 2) * scale)
    assert.ok(Math.max(...corner) < 90 + tolerance, `the window edge is dark, got ${corner}`)
  })
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
let failed = false
try {
  // The lab first: on a cold runner the first launch (Bun's transpile cache, Mesa's
  // shader cache) can starve the app's daemon probe.
  if (only !== 'app') await shoot(path.join(import.meta.dir, '../native/clip-lab.tsx'), 'ready', `${os}-clip.png`, { KYBERN_DATA_DIR: data }, verifyLab)
  if (only !== 'lab') await shoot(app, 'app-ready', `${os}-app.png`, scratchEnv, verifyApp, `Show me the GPUIX client running on ${os}.`)
} catch (error) {
  failed = true
  console.error(`[smoke] FAILED: ${error instanceof Error ? error.message : error}`)
}
stop()
process.exit(failed ? 1 : 0)
