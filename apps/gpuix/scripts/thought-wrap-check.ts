/** Expanded reasoning ("Thought") wraps inside the chat column instead of
 * running off its right edge. Scratch daemon only; never builds.
 *   bun scripts/thought-wrap-check.ts [out-dir] [--light]
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { Database } from 'bun:sqlite'
import { launch } from '@gpuix/react/automation'
import { KybernClient } from '../../../packages/kybern-client/src/client.ts'

const args = process.argv.slice(2)
const out = path.resolve(args.find((a) => !a.startsWith('--')) ?? 'screenshots/thought-wrap')
const theme = args.includes('--light') ? 'light' : 'dark'
mkdirSync(out, { recursive: true })
const bin = process.env.KYBERN_TEST_DAEMON ?? '/Applications/kybern.app/Contents/MacOS/kybernd'
const scratch = mkdtempSync(path.join(tmpdir(), 'gpuix-scratch-thought-')), data = path.join(scratch, 'data')
mkdirSync(data); mkdirSync(path.join(scratch, 'project'))
const daemon = spawn(bin, ['--data-dir', data, '--port', '0'], { stdio: 'ignore' })
const THINKING = 'Confirmed: the earlier study only covered scrolling, Markdown, startup and memory, not these four new problems. '.repeat(6) + '\n\nA second paragraph keeps its own line break and also wraps across the column width without overflowing.'
let client: KybernClient | undefined
let app: Awaited<ReturnType<typeof launch>> | undefined
try {
  const deadline = Date.now() + 30000
  while (!existsSync(path.join(data, 'daemon.port'))) { if (Date.now() > deadline || daemon.exitCode !== null) throw Error('Scratch daemon failed'); await Bun.sleep(30) }
  const port = readFileSync(path.join(data, 'daemon.port'), 'utf8').trim()
  client = new KybernClient({ url: `ws://127.0.0.1:${port}/ws`, token: readFileSync(path.join(data, 'daemon.token'), 'utf8').trim() }); client.connect()
  while (client.status !== 'open') { if (Date.now() > deadline) throw Error('Scratch connection failed'); await Bun.sleep(30) }
  const project = await client.call('projects.add', { path: path.join(scratch, 'project'), name: 'scratch-project' })
  const thread = await client.call('threads.create', { project_id: project.id, title: 'Thought wrap', provider: { kind: 'claude-code', instance: 'default' }, model: 'claude-haiku-5-5' })
  const db = new Database(path.join(data, 'state.sqlite'))
  try {
    const turn = crypto.randomUUID(), message = crypto.randomUUID()
    const insert = db.query('INSERT INTO events(thread_id,turn_id,at,kind,payload) VALUES (?,?,?,?,?)')
    for (const event of [
      { kind: 'turn_started', message_id: crypto.randomUUID(), message: { parts: [{ type: 'text', text: 'Look at zeron and Zed.' }] } },
      { kind: 'assistant_message_completed', message_id: message, origin: { kind: 'root' }, text: 'Done.', thinking: THINKING },
      { kind: 'turn_completed', stop_reason: 'completed', usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0 }, cost_usd: null, duration_ms: 1000, terminal_message_id: message },
    ]) insert.run(thread.id, turn, '2026-10-19T09:00:00Z', event.kind, JSON.stringify(event))
    db.query('UPDATE threads SET last_seq=(SELECT MAX(seq) FROM events WHERE thread_id=?) WHERE id=?').run(thread.id, thread.id)
  } finally { db.close() }
  app = await launch({
    command: 'bun',
    args: [path.join(import.meta.dir, '../src/main.tsx')],
    env: { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: theme, KYBERN_REDUCED_MOTION: '1', KYBERN_DATA_DIR: data, KYBERN_CLIENT_CONFIG_DIR: path.join(scratch, 'client'), KYBERN_GPUIX_CREDENTIALS_DIR: path.join(scratch, 'credentials'), KYBERN_GPUIX_THREAD: thread.id, KYBERN_GPUIX_ENVIRONMENT: 'local', KYBERN_URL: '', KYBERN_TOKEN: '' },
  })
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
  // Reasoning is folded under "Worked for …"; open that group first.
  const findDiv = async (prefix: string) => (await app!.getByType('div').all()).find((n) => n.testId?.startsWith(prefix) && !n.testId.startsWith(`${prefix}panel`) && (n.bounds?.height ?? 0) > 0)
  let worked: Awaited<ReturnType<typeof findDiv>>
  for (const until = Date.now() + 20_000; !worked?.bounds && Date.now() < until; await Bun.sleep(100)) worked = await findDiv('worked-')
  assert.ok(worked?.bounds, 'no Worked group rendered')
  await app.mouse.click({ x: worked.bounds.x + 20, y: worked.bounds.y + worked.bounds.height / 2 })
  let toggle: { testId?: string; bounds?: { x: number; y: number; width: number; height: number } } | undefined
  for (const until = Date.now() + 20_000; !toggle?.bounds && Date.now() < until; await Bun.sleep(100))
    toggle = (await app.getByType('div').all()).find((n) => n.testId?.startsWith('thought-') && (n.bounds?.height ?? 0) > 0)
  if (!toggle?.bounds) await app.screenshot({ path: path.join(out, `missing-${theme}.png`) })
  assert.ok(toggle?.bounds, 'no Thought row rendered')
  await app.mouse.click({ x: toggle.bounds.x + 20, y: toggle.bounds.y + toggle.bounds.height / 2 })
  const body = app.getByText(THINKING)
  await body.waitFor({ timeoutMs: 10_000 })
  await Bun.sleep(600)
  await app.screenshot({ path: path.join(out, `thought-${theme}.png`) })
  const text = await body.bounds(), row = toggle.bounds
  const columnRight = row.x + row.width
  console.log(`[thought-wrap] text x=${text.x.toFixed(1)} w=${text.width.toFixed(1)} h=${text.height.toFixed(1)}; column right=${columnRight.toFixed(1)}`)
  assert.ok(text.x + text.width <= columnRight + 1, `thought text overflows the column (${(text.x + text.width).toFixed(1)} > ${columnRight.toFixed(1)})`)
  assert.ok(text.height > 3 * 20, `thought text did not wrap (height ${text.height.toFixed(1)})`)
  console.log(`[thought-wrap] ok (${theme}); ${path.join(out, `thought-${theme}.png`)}`)
} finally {
  await app?.close().catch(() => {})
  client?.close(); daemon.kill()
  await new Promise<void>((resolve) => { if (daemon.exitCode !== null) resolve(); else daemon.once('exit', () => resolve()) })
  rmSync(scratch, { recursive: true, force: true })
}
