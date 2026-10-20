// Real-app evidence for the chat fixes (lane chatfix2): the orchestrator's table reply, a long final reply (no
// "Show more"), an inbound agent message (still clamped) beside "Sent to" rows with harness marks, agent reply images
// (hidden folder, outside path the reply names, and the refusals), and a rejected send (Not sent, Retry, Edit).
// Own scratch daemon (this checkout's kybernd, port 4377) on the stand-in Claude CLI; threads get their content as
// SQL-appended events, like perf/bench/seed.ts. Screenshots in both themes go to previews/chatfix2/visual.
//   bun src/transcript/chatfix2.verify.ts
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { connect, gradientPng } from '../../visual/fixture.ts'
import { launchFixture } from '../requests/harness.ts'
import { lease } from '../../perf/bench/lease.ts'

const DATA = '/Users/mymac/projects/ade-gpuix-scratch/chatfix2-visual'
const PORT = 4377
const OUT = process.env.KYBERN_VERIFY_OUTPUT ?? '/Users/mymac/projects/ade/previews/chatfix2/visual'
const root = path.resolve(import.meta.dir, '../..')
// The real messages (read-only from the user's database) can be passed as files; the defaults keep their shape.
const TABLE_REPLY = [
  'The composer tray work is done and merged into the motion branch.', '',
  ...Array.from({ length: 11 }, (_, i) => [`**Point ${i + 1}:** what changed, and how it was checked.`, '']).flat(),
  '![Composer tray open, dark theme](.screenshots/money/money-dark-1280.png)', '',
  '**Still running:**', '',
  '| Agent | Job |', '|---|---|',
  '| Opus · GPUIX native | Menu start delay, hover colour fades, height animations |',
  '| Sonnet · GPUIX dock and overlays | Package 3 |',
  '| Sonnet · GPUIX pages | Package 4 |',
  '| Opus · Tree connectors | Sidebar, "Worked for" groups and the Agents tree |', '',
  'After they finish: an Opus review of the whole branch, then a PR.',
].join('\n')
const IMAGE_REPLY = [
  'All three requests are done, each on its own branch.', '',
  '| Branch | What |', '|---|---|', '| `fix/label` | The button label |', '| `feature/times` | Required delivery and collection times |', '',
  '**Money, one row per booking.**', '', '![Money, dark](.screenshots/money/money-dark-1280.png)', '',
  '**Booking times.**', '- Delivery and collection times are required.', '- A later collection adds a late fee.', '',
  '![Booking form, desktop](.screenshots/times/trip-1280.png)', '',
  '![Booking form, Indonesian, 7 h late](.screenshots/times/trip-390-id-extra-day.png)', '',
  'All screenshots come from throwaway local databases.',
].join('\n')
const md = (name: 'table-reply.md' | 'image-reply.md') => process.env.CHATFIX_REAL_MESSAGES ? readFileSync(path.join(process.env.CHATFIX_REAL_MESSAGES, name), 'utf8') : name === 'table-reply.md' ? TABLE_REPLY : IMAGE_REPLY
rmSync(DATA, { recursive: true, force: true }); mkdirSync(DATA, { recursive: true }); mkdirSync(OUT, { recursive: true })
const fake = path.join(root, 'perf/send/fake-claude.ts')
chmodSync(fake, 0o755)
writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ providers: { 'claude-code': { binary: fake, env: { FAKE_CLAUDE_TURN_MS: '200' } } } }))
const daemon = spawn(process.env.CHATFIX_DAEMON ?? path.resolve(root, '../../target/debug/kybernd'), ['--data-dir', DATA, '--port', String(PORT)], { stdio: 'ignore', env: { ...process.env, KYBERN_URL: '', KYBERN_TOKEN: '' } })
process.on('exit', () => { try { daemon.kill() } catch {} })
for (let i = 0; i < 300 && !existsSync(path.join(DATA, 'daemon.port')); i++) await Bun.sleep(50)
await Bun.sleep(300)
const token = readFileSync(path.join(DATA, 'daemon.token'), 'utf8').trim()
const client = await connect({ daemonPid: daemon.pid!, port: PORT, token, seeded: false } as never) as unknown as { call: (m: string, p: unknown) => Promise<any> }

// A workspace like the user's: screenshots in a dot-folder, and one outside image the reply names by absolute path.
const work = path.join(DATA, 'projects', 'ridenation-web')
mkdirSync(path.join(work, '.screenshots/times'), { recursive: true }); mkdirSync(path.join(work, '.screenshots/money'), { recursive: true }); mkdirSync(path.join(work, 'src'), { recursive: true })
writeFileSync(path.join(work, 'src/index.ts'), 'export {}\n')
writeFileSync(path.join(work, '.screenshots/times/trip-1280.png'), gradientPng(1280, 800))
writeFileSync(path.join(work, '.screenshots/times/trip-390-id-extra-day.png'), gradientPng(390, 844))
writeFileSync(path.join(work, '.screenshots/money/money-dark-1280.png'), gradientPng(1280, 720))
writeFileSync(path.join(work, '.env'), 'SECRET=1\n')
execFileSync('git', ['init', '-q', work]); execFileSync('git', ['-C', work, 'add', 'src']); execFileSync('git', ['-C', work, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'])
// Outside the workspace and outside the daemon's data folder (which is protected).
const OUTSIDE = '/Users/mymac/projects/ade-gpuix-scratch/chatfix2-outside'
const outside = path.join(OUTSIDE, 'Booking form spät.png')
mkdirSync(path.dirname(outside), { recursive: true }); writeFileSync(outside, gradientPng(640, 400))
mkdirSync(path.join(DATA, 'assets'), { recursive: true }); writeFileSync(path.join(DATA, 'assets', 'protected.png'), gradientPng(64, 64))
const project = await client.call('projects.add', { path: work })
const provider = { kind: 'claude-code', instance: 'default' }
const idle = async (id: string) => { for (let i = 0; i < 400; i++) { if ((await client.call('threads.get', { thread_id: id })).thread.status === 'idle') return; await Bun.sleep(25) } throw Error('never idle') }
async function thread(title: string, worktree = false) {
  const t = await client.call('threads.create', { project_id: project.id, provider, pin_account: false, permission_mode: 'supervised', use_worktree: worktree, title, message: { parts: [{ type: 'text', text: `Open ${title}` }] } })
  await idle(t.id)
  await client.call('threads.update', { thread_id: t.id, title })
  return t.id as string
}
/** One settled turn: the user's prompt (or parts), tool calls, then the reply. */
function turn(threadId: string, prompt: unknown[], reply: string, tools: { name: string; input: unknown; output: unknown }[] = []) {
  const db = new Database(path.join(DATA, 'state.sqlite'))
  try {
    const turnId = crypto.randomUUID(), message = crypto.randomUUID(), at = new Date().toISOString()
    const insert = db.query('INSERT INTO events(thread_id,turn_id,at,kind,payload) VALUES (?,?,?,?,?)')
    const events: Record<string, unknown>[] = [{ kind: 'turn_started', message_id: crypto.randomUUID(), message: { parts: prompt } }]
    for (const tool of tools) {
      const id = crypto.randomUUID()
      events.push({ kind: 'tool_call_started', call: { id, name: tool.name, input: tool.input }, origin: { kind: 'root' } }, { kind: 'tool_call_completed', tool_call_id: id, output: tool.output, is_error: false })
    }
    events.push({ kind: 'assistant_message_completed', message_id: message, origin: { kind: 'root' }, text: reply, thinking: null },
      { kind: 'turn_completed', stop_reason: 'completed', usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_write_tokens: 0 }, cost_usd: null, duration_ms: 1200, terminal_message_id: message })
    for (const event of events) insert.run(threadId, turnId, at, String(event.kind), JSON.stringify(event))
    db.query('UPDATE threads SET last_seq=(SELECT MAX(seq) FROM events WHERE thread_id=?) WHERE id=?').run(threadId, threadId)
  } finally { db.close() }
}
const text = (t: string) => [{ type: 'text', text: t }]

const tableThread = await thread('Motion phase')
turn(tableThread, text('Where are we?'), md('table-reply.md'))
const longThread = await thread('Long final reply')
const sections: string[] = []
for (let i = 0; sections.join('\n\n').length < 40000; i++) sections.push(i % 6 === 2 ? `| Step | Result |\n|---|---|\n| ${i} | ok |\n| ${i + 1} | ok |` : i % 4 === 1 ? `### Part ${i}\n\n- point one for part ${i}\n- point two` : `Paragraph ${i}. ${'The fix keeps every block whole and bounded. '.repeat(8)}`)
turn(longThread, text('Write the full report.'), `${sections.join('\n\n')}\n\nEnd of the long reply.`)
const messagesThread = await thread('Agent messages')
const brief = Array.from({ length: 30 }, (_, i) => `${i + 1}. Brief step ${i + 1}: keep the clamp for agent-to-agent prompts.`).join('\n')
turn(messagesThread, [{ type: 'thread_message', message_id: crypto.randomUUID(), from_thread_id: tableThread, from_title: 'Motion phase', purpose: 'task', body: brief }], 'Done: the brief is in hand.', [
  { name: 'mcp__kybern__kybern_thread_send', input: { thread_id: tableThread, body: 'Tree connectors for nested rows and expand motion are ready for review.', purpose: 'message' }, output: { message_id: crypto.randomUUID(), status: 'delivered' } },
  { name: 'mcp__kybern__kybern_thread_send', input: { thread_id: crypto.randomUUID(), body: 'A thread this client has not loaded.', purpose: 'question' }, output: { message_id: crypto.randomUUID(), status: 'delivered' } },
])
const imagesThread = await thread('Booking form screenshots')
turn(imagesThread, text('Show me the booking form.'), md('image-reply.md'))
const refusalsThread = await thread('Image refusals')
turn(refusalsThread, text('And the edge cases?'), `Outside the folder, named here:\n\n![Booking form, outside](${outside})\n\nAnd the refusals:\n\n![Not saved yet](.screenshots/times/missing.png)\n\n![Environment file](.env)\n\n![Daemon data](${path.join(DATA, 'assets', 'protected.png')})`)
// A send the daemon rejects: this thread's worktree folder is gone without a removal receipt.
const failingThread = await thread('Rejected send', true)
const worktree = (await client.call('threads.get', { thread_id: failingThread })).thread.cwd as string
rmSync(worktree, { recursive: true, force: true })

const until = async (check: () => Promise<boolean>, label: string, ms = 8000) => { const end = Date.now() + ms; for (;;) { try { if (await check()) return } catch {} if (Date.now() > end) throw Error(`Timed out: ${label}`); await Bun.sleep(40) } }
const results: string[] = []
for (const variant of (process.env.CHATFIX_VARIANTS ?? 'dark,light').split(',')) {
  for (const [name, id] of [['table', tableThread], ['long', longThread], ['messages', messagesThread], ['images', imagesThread], ['refusals', refusalsThread], ['failed', failingThread]] as const) {
    if (process.env.CHATFIX_ONLY && !process.env.CHATFIX_ONLY.split(',').includes(name)) continue
    const release = await lease()
    const scratch = path.join(DATA, 'client', `${variant}-${name}`); mkdirSync(scratch, { recursive: true })
    const f = await launchFixture(path.join(root, 'src/main.tsx'), {
      KYBERN_DATA_DIR: DATA, KYBERN_URL: `ws://127.0.0.1:${PORT}/ws`, KYBERN_TOKEN: token, KYBERN_CLIENT_CONFIG_DIR: scratch, KYBERN_GPUIX_CREDENTIALS_DIR: path.join(scratch, 'credentials'),
      KYBERN_GPUIX_THREAD: id, GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: variant, KYBERN_WINDOW_SIZE: '1280x900',
      NAPI_RS_NATIVE_LIBRARY_PATH: process.env.NAPI_RS_NATIVE_LIBRARY_PATH ?? path.join(root, 'native/build/gpuix-native.darwin-arm64.node'),
    })
    try {
      const app = f.app
      const painted = async () => String((await app.call('getPaintedText', {})).text)
      await app.getByTestId('composer').waitFor({ timeoutMs: 30000 })
      // A restored split view can win over KYBERN_GPUIX_THREAD; open the thread from the sidebar.
      await until(async () => (await app.getByTestId(`thread-${id}`).count()) > 0, 'sidebar row', 15000)
      await app.getByTestId(`thread-${id}`).click()
      await Bun.sleep(1500)
      if (name === 'table') {
        await until(async () => (await painted()).includes('Still running'), 'table reply')
        const shown = await painted()
        assert.ok(!shown.includes('|---|---|'), 'the delimiter row never paints as text')
        assert.ok(shown.includes('Opus · GPUIX native') && !shown.includes('| Opus'), 'rows paint as table cells')
      }
      if (name === 'long') {
        await until(async () => (await painted()).includes('End of the long reply'), 'long reply tail')
        assert.ok(!(await painted()).includes('Show more'), 'a final reply never offers Show more')
      }
      if (name === 'messages') {
        await until(async () => (await painted()).includes('Sent to'), 'sent rows')
        assert.ok((await app.getByTestId('clamp-toggle').count()) > 0, 'an inbound agent prompt stays clamped with Show more')
      }
      if (name === 'images') {
        // The reply's tail: the two screenshots from the hidden `.screenshots` folder.
        await until(async () => (await app.getByTestId('response-image').count()) >= 2, 'hidden-folder images render', 15000)
        const shown = await painted()
        assert.ok(!shown.includes('![') && !shown.includes('not browsable'), 'no image paints as Markdown text or a folder refusal')
      }
      if (name === 'refusals') {
        await until(async () => (await app.getByTestId('response-image').count()) >= 1, 'the outside image the reply names renders', 15000)
        // The missing file is retried once (1.5 s) before its card says so.
        await until(async () => (await painted()).includes('Image not found'), 'missing-file card', 8000)
        const shown = await painted()
        for (const reason of ['Not a PNG, JPEG, GIF, WebP or AVIF image', 'This folder is protected']) assert.ok(shown.includes(reason), reason)
      }
      if (name === 'failed') {
        const composer = app.getByTestId('composer')
        await composer.fill('Continue in the missing worktree')
        const t0 = performance.now()
        await composer.press('enter')
        await until(async () => (await painted()).includes('Continue in the missing worktree') && (await app.getByTestId('composer-placeholder').count()) > 0, 'optimistic bubble')
        results.push(`${variant} failed-send bubble ${Math.round(performance.now() - t0)} ms`)
        await until(async () => (await app.getByTestId('send-failed').count()) > 0, 'Not sent row')
        assert.ok((await painted()).includes('Not sent.'), 'the reason shows')
        await Bun.sleep(500)
        await app.screenshot({ path: `${OUT}/${name}-${variant}.png` })
        await app.getByTestId('send-edit').click()
        await until(async () => (await app.getByTestId('send-failed').count()) === 0 && (await app.getByTestId('composer-placeholder').count()) === 0, 'Edit puts the text back')
        await app.screenshot({ path: `${OUT}/${name}-edit-${variant}.png` })
      } else { await Bun.sleep(500); await app.screenshot({ path: `${OUT}/${name}-${variant}.png` }) }
      results.push(`ok ${variant} ${name}`)
      console.log(`ok ${variant} ${name}`)
    } catch (error) { await f.app.screenshot({ path: `${OUT}/fail-${name}-${variant}.png` }).catch(() => {}); console.log(f.diagnostics().slice(-3000)); throw error } finally { await f.close(); release() }
  }
}
console.log(results.join('\n'))
daemon.kill()
rmSync(DATA, { recursive: true, force: true }); rmSync(OUTSIDE, { recursive: true, force: true })
process.exit(0)
