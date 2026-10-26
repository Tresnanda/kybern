// The surfaces that need a web view, with none (WP4): a preview, an interactive visual, a question, an HTML artifact and a
// Mermaid fence, in the real app with `KYBERN_GPUIX_NO_WEBVIEW=1` on a scratch daemon. Screenshots go to
// `KYBERN_VERIFY_OUTPUT`. `open` is replaced by a stub that records what Kybern asked the system to open, so no browser starts.
// `macos` as the second argument launches without the switch (needs KYBERN_GPUIX_RESOURCES for the web view library and
// Mermaid) and asserts the embedded behaviour is unchanged: live visuals, tabs, the send button, a drawn diagram, the slot.
//   VISUAL_SCRATCH=/Users/mymac/projects/ade-gpuix-scratch/wp4 KYBERND="/Applications/Kybern GPUIX.app/Contents/MacOS/kybernd" bun scripts/nowebview-app-check.ts [dark|light]
// Off macOS (WP7, `scripts/run-platform-checks.ts`): the same check, with `KYBERN_OPEN_LOG` recording what Kybern asks the
// system to open (no stub can stand in for `rundll32` or the addon's own opener), captured through `native/check-harness.ts`.
// The parts that need the wheel or a ⌘ shortcut are known gaps there until WP1 and WP3 land (`KYBERN_CHECK_STRICT=1` enforces them).
import assert from 'node:assert/strict'
import { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { DATA_DIR, SCRATCH, connect, startDaemon, stopPid } from '../visual/fixture.ts'
import { GAPS, capture, launch, outputDir, platform, step } from '../native/check-harness.ts'
import { BUNDLE_PAGE, LAYOUT_PAGE, LAYOUT_SCHEMA } from '../src/transcript/visual.pages.ts'
// The shortcut key: ⌘ on macOS, Ctrl elsewhere (WP3, `src/platform/keys.ts`).
const PRIMARY = process.platform === 'darwin' ? 'cmd' : 'ctrl'

const variant = (process.argv[2] ?? 'dark') as 'dark' | 'light'
const mac = process.argv[3] === 'macos'
if (mac && platform !== 'macos') throw Error('The `macos` variant needs macOS: it checks the embedded web view')
const out = outputDir('nowebview')
const until = async (check: () => Promise<boolean> | boolean, label: string, ms = 20000) => { const end = Date.now() + ms; for (;;) { try { if (await check()) return } catch {} if (Date.now() > end) throw Error(`Timed out: ${label}`); await Bun.sleep(50) } }

// ---- seed ----
const BROWSER = '154.0.8037.92'
const installed = path.join(homedir(), '.kybern/cache/html-preview', BROWSER), linked = path.join(DATA_DIR, 'cache/html-preview', BROWSER)
const state = await startDaemon(true)
process.on('exit', () => stopPid(state.daemonPid))
if (existsSync(installed) && !existsSync(linked)) { mkdirSync(path.dirname(linked), { recursive: true }); symlinkSync(installed, linked) }
const client = await connect(state)
const workspace = path.join(SCRATCH, 'workspace')
mkdirSync(workspace, { recursive: true })
writeFileSync(path.join(workspace, 'report.html'), '<!doctype html><title>Report</title><h1>Quarterly report</h1><button onclick="this.textContent=\'Clicked\'">Click</button>')
const project = await client.call('projects.add', { path: workspace, name: 'wp4' })
const thread = await client.call('threads.create', { project_id: project.id, provider: { kind: 'claude-code', instance: 'default' }, permission_mode: 'supervised', title: 'No web view' })
const db = new Database(path.join(DATA_DIR, 'state.sqlite'))
db.exec('PRAGMA busy_timeout = 5000')
const insert = db.prepare('INSERT INTO events(thread_id, turn_id, at, kind, payload) VALUES (?1, ?2, ?3, ?4, ?5)')
const usage = { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0 }
const turn = randomUUID(), answer = randomUUID()
const MERMAID = '```mermaid\nflowchart LR\n  A[Agent] --> B{Web view?}\n  B -- yes --> C[Draw the diagram]\n  B -- no --> D[Show the source]\n```'
const events = [
  { kind: 'turn_started', message_id: randomUUID(), message: { parts: [{ type: 'text', text: 'Show the bundle sizes, the flow, and ask me about the layout.' }] } },
  { kind: 'assistant_message_completed', message_id: answer, origin: { kind: 'root' }, text: `Here is how the flow works, then the sizes and a question.\n\n${MERMAID}\n\nThe threads route is the heaviest.`, thinking: null },
  { kind: 'turn_completed', stop_reason: 'completed', usage, cost_usd: 0, duration_ms: 1000, terminal_message_id: answer },
]
const start = Date.now() - 600_000
events.forEach((ev, i) => insert.run(thread.id, turn, new Date(start + i * 1500).toISOString(), ev.kind, JSON.stringify(ev)))
const last = db.query('SELECT max(seq) AS s FROM events WHERE thread_id = ?1').get(thread.id) as { s: number }
db.prepare('UPDATE threads SET last_seq = ?2, status = ?3 WHERE id = ?1').run(thread.id, last.s, 'idle')
const bundle = await client.call('threads.visuals.publish', { thread_id: thread.id, title: 'Bundle size by route', height: 600, html: BUNDLE_PAGE })
// The daemon only lets an agent's tool call wait for an answer, so the question is a plain visual whose published event gets an `ask`.
const asked = await client.call('threads.visuals.publish', { thread_id: thread.id, title: 'Pick a layout', height: 420, html: LAYOUT_PAGE })
const row = db.query("SELECT seq, payload FROM events WHERE thread_id = ?1 AND payload LIKE ?2").get(thread.id, `%${asked.visual.id}%`) as { seq: number; payload: string } | null
if (!row) throw Error('The published visual has no event')
const published = JSON.parse(row.payload)
console.log('published event kind:', published.kind)
// No installed preview browser to link (CI): the pictures would race the daemon's 120 MB install, whose first
// snapshot fails with "installing". One snapshot starts that install; wait for it before the app asks.
if (!existsSync(linked)) {
  const started = Date.now()
  let last = ''
  for (;;) {
    try {
      await client.call('threads.visuals.snapshot', { thread_id: thread.id, visual_id: bundle.visual.id, width: 640, theme: { appearance: variant, variables: {} }, lock: null })
      break
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message !== last) console.log(`[nowebview] preview browser: ${message}`)
      last = message
    }
    if (Date.now() - started > 600_000) throw Error(`Timed out: the preview browser install (${last})`)
    await Bun.sleep(2000)
  }
  console.log(`[nowebview] preview browser ready in ${Math.round((Date.now() - started) / 1000)} s`)
}
const target = published.visual ?? published.html_visual ?? published
target.ask = { schema: LAYOUT_SCHEMA }
db.prepare('UPDATE events SET payload = ?2 WHERE seq = ?1').run(row.seq, JSON.stringify(published))
// The waiting card (the agent's tool call normally raises it): a daemon-owned approval for this visual.
db.prepare('INSERT INTO approvals(id, thread_id, turn_id, payload, resolved, created_at) VALUES (?1, ?2, ?3, ?4, 0, ?5)').run(randomUUID(), thread.id, turn, JSON.stringify({
  id: randomUUID(), thread_id: thread.id, turn_id: turn, tool_name: 'kybern_visual_answer', input: { visual_id: asked.visual.id, title: 'Pick a layout', schema: LAYOUT_SCHEMA }, summary: 'Pick a layout', suggestions: [], created_at: new Date().toISOString(), questions: [],
}), new Date().toISOString())
db.close()

// ---- a page to preview, and an `open` that only records ----
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<!doctype html><title>Local app</title><h1>Local app</h1>', { headers: { 'content-type': 'text/html' } }) })
const stubs = path.join(SCRATCH, 'stubs'), opened = path.join(SCRATCH, 'opened.log')
mkdirSync(stubs, { recursive: true }); writeFileSync(opened, '')
// macOS stubs `open` on PATH. Elsewhere the app's open seam (`KYBERN_OPEN_LOG`) writes the same file.
if (platform === 'macos') { writeFileSync(path.join(stubs, 'open'), `#!/bin/sh\necho "$@" >> "${opened}"\n`); chmodSync(path.join(stubs, 'open'), 0o755) }
const openedLines = () => readFileSync(opened, 'utf8').split('\n').filter(Boolean)

const clientDir = path.join(SCRATCH, 'client'), creds = path.join(SCRATCH, 'credentials')
mkdirSync(clientDir, { recursive: true })
const f = await launch(path.join(import.meta.dir, 'nowebview-app.fixture.ts'), {
  KYBERN_OPAQUE: '1', KYBERN_APPEARANCE: variant, KYBERN_DATA_DIR: DATA_DIR, KYBERN_CLIENT_CONFIG_DIR: clientDir, KYBERN_GPUIX_CREDENTIALS_DIR: creds,
  KYBERN_ENVIRONMENT_NAME: 'Development environment', ...(mac ? {} : { KYBERN_GPUIX_NO_WEBVIEW: '1' }), KYBERN_GPUIX_THREAD: thread.id, KYBERN_PREVIEW_TARGET: `http://127.0.0.1:${server.port}/`,
  KYBERN_WINDOW_SIZE: process.env.KYBERN_WINDOW_SIZE ?? '1280x1280', PATH: `${stubs}${path.delimiter}${process.env.PATH}`,
  ...(platform === 'macos' ? {} : { KYBERN_OPEN_LOG: opened }),
})
const app = f.app
const clickFirst = async (testId: string) => { const b = (await app.getByTestId(testId).all())[0]!.bounds!; await app.mouse.click({ x: b.x + b.width / 2, y: b.y + b.height / 2 }) }
const shot = (name: string) => capture(f, `${out}/${name}-${variant}${mac ? '-macos' : ''}.png`)
try {
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
  await until(async () => (await app.getByTestId('visual-picture').count()) >= 2, 'the pictures')


  if (mac) {
    // Embedded: the preview lives in a slot and opens no browser; a diagram is drawn; the picture goes live on a click; the question has its send button.
    await until(async () => (await app.getByTestId('diagram-image').count()) > 0, 'the diagram is drawn', 30000)
    assert.equal(openedLines().length, 0, 'the preview must not open a browser')
    assert.equal(await app.getByTestId('visual-open-browser').count(), 0)
    assert.equal(await app.getByTestId('visual-answer-reply').count(), 0)
    assert.ok((await app.getByTestId('visual-answer-send').count()) >= 1, 'the send button stays')
    assert.ok((await app.getByTestId('visual-expand').count()) >= 1, 'Open in a tab stays')
    const b = (await app.getByTestId('visual-figure').all()).at(-1)!.bounds!
    await app.mouse.click({ x: b.x + b.width / 2, y: b.y + 80 })
    await until(async () => (await app.getByTestId('visual-ring-live').count()) > 0, 'a click makes it live (its ring)', 20000)
    await shot('mac-live')
    await app.getByTestId('app-ready').press('escape'); await Bun.sleep(500)
    await app.getByTestId('app-ready').press(`${PRIMARY}-2`); await until(async () => (await app.getByTestId('preview-slot-dock').count()) > 0, 'the embedded slot')
    assert.equal(await app.getByTestId('preview-open-again').count(), 0)
    assert.equal(openedLines().length, 0)
    console.log('PASS macos unchanged: embedded preview slot, live visual, send button, drawn diagram, Open in a tab')
    process.exit(0)
  }
  // The preview opened the browser as soon as it was ready (the stub recorded the address).
  await until(() => openedLines().includes(`http://127.0.0.1:${server.port}/`), 'the preview opens in the browser')

  // Chat: Mermaid keeps its source and says why; the visual is a picture with Open in browser; the question has a reply bar.
  await until(async () => (await app.getByTestId('mermaid-block').count()) > 0, 'the Mermaid fence')
  assert.equal(await app.getByTestId('diagram-image').count(), 0, 'no diagram is drawn without a web view')
  assert.equal(await app.getByTestId('diagram-note').count(), 1, 'the note explains why')
  await step('chat: Mermaid source, static visuals, question bar, Open in browser, full screen', async () => {
    await app.mouse.wheel({ x: 700, y: 400 }, 0, -4000); await Bun.sleep(700)
    await shot('1-mermaid-source')
    await app.mouse.wheel({ x: 700, y: 400 }, 0, 8000); await Bun.sleep(900)
    assert.equal(await app.getByTestId('visual-live').count(), 0)
    assert.ok((await app.getByTestId('visual-open-browser').count()) >= 1, 'a static visual offers Open in browser')
    assert.equal(await app.getByTestId('visual-expand').count(), 0, 'no Open in a tab without a web view')
    assert.equal(await app.getByTestId('visual-answer-send').count(), 0, 'no send button: the page cannot draft')
    assert.equal(await app.getByTestId('visual-answer-reply').count(), 1, 'the bar offers replying in words')
    assert.equal(await app.getByTestId('visual-answer-skip').count(), 1)
    await shot('2-visual-and-question')
    // Bring the first visual's caption into view (its Open in browser button).
    for (const delta of [600, -600, 1200, -1200]) {
      const top = (await app.getByTestId('visual-open-browser').all())[0]!.bounds!.y
      if (top > 90) break
      await app.mouse.wheel({ x: 700, y: 400 }, 0, delta); await Bun.sleep(500)
    }
    await Bun.sleep(400)
    console.log('open button bounds', JSON.stringify((await app.getByTestId('visual-open-browser').all()).map(n => n.bounds)))
    await shot('2b-visual-caption')

    // Clicking the picture does not go live.
    const figures = await app.getByTestId('visual-figure').all()
    const box = figures[0]!.bounds!
    await app.mouse.click({ x: box.x + box.width / 2, y: box.y + 40 }); await Bun.sleep(700)
    assert.equal(await app.getByTestId('visual-live').count(), 0, 'a click must not go live')
    assert.equal(await app.getByTestId('visual-ring-live').count(), 0)

    // Open in browser mints a frame ticket and hands its URL to the system; the page is served once.
    const before = openedLines().length
    await clickFirst('visual-open-browser')
    await until(() => openedLines().length > before, 'the visual opens in the browser')
    const url = openedLines().at(-1)!
    assert.match(url, /\/visual-frame\/[0-9a-f-]+#kybern-theme=/)
    const first = await fetch(url.split('#')[0]!)
    assert.equal(first.status, 200)
    const html = await first.text()
    assert.match(html, /if \(window\.parent !== window\) window\.parent\.postMessage/, 'the page posts to a parent frame only')
    assert.equal((await fetch(url.split('#')[0]!)).status, 404, 'the ticket works once')
    writeFileSync(path.join(out, 'browser-answer-finding.txt'), `Served from the frame ticket (top-level, no parent): bootstrap posts only when window.parent !== window, so kybern.answer.draft/submit do nothing in a browser tab; the page CSP (connect-src https:, sandbox allow-scripts) cannot reach the daemon; the ticket is single use (60 s).\n`)

    // Full screen: the picture at size, no live document, the same action; the question bar is in the viewer.
    await clickFirst('visual-full-screen')
    await until(async () => (await app.getByTestId('visual-viewer').count()) > 0, 'the full-screen viewer')
    await until(async () => (await app.getByTestId('visual-still-picture').count()) > 0, 'the picture in the viewer')
    await Bun.sleep(500)
    assert.equal(await app.getByTestId('visual-viewer-open-tab').count(), 0)
    assert.equal(await app.getByTestId('visual-still-open-browser').count(), 1)
    await shot('3-viewer')
    await app.getByTestId('visual-viewer-close').click(); await until(async () => (await app.getByTestId('visual-viewer').count()) === 0, 'the viewer closes')
  }, { gap: GAPS.wheel })

  await step('dock and artifact tab (⌘2 / ⌘3 / ⌘1)', async () => {
    // The dock: the preview tab says it is in the browser, with Open again and Copy link; no device or float controls.
    await app.getByTestId('app-ready').press(`${PRIMARY}-2`); await Bun.sleep(700)
    await until(async () => (await app.getByTestId('preview-state').count()) > 0, 'the browser-only state')
    assert.equal(await app.getByTestId('preview-open-again').count(), 1); assert.equal(await app.getByTestId('preview-copy-link').count(), 1)
    assert.equal(await app.getByTestId('preview-slot-dock').count(), 0, 'no embedded slot')
    assert.equal(await app.getByTestId('preview-float').count(), 0); assert.equal(await app.getByTestId('preview-device').count(), 0)
    await shot('4-preview-in-browser')
    const again = openedLines().length
    await app.getByTestId('preview-open-again').click()
    await until(() => openedLines().length > again, 'Open again opens the browser')

    // An HTML artifact (a tab): the frame becomes a state with Open in browser, and Source still shows the file.
    await app.getByTestId('app-ready').press(`${PRIMARY}-3`); await Bun.sleep(900)
    await until(async () => (await app.getByTestId('artifact-browser').count()) > 0, 'the artifact state')
    assert.equal(await app.getByTestId('artifact-frame').count(), 0)
    await shot('5-artifact-idle')
    const artifactOpen = openedLines().length
    await app.getByTestId('artifact-open-browser').click()
    await until(() => openedLines().length > artifactOpen, 'the artifact opens in the browser')
    assert.match(openedLines().at(-1)!, /\/artifact-preview\/[0-9a-f-]+$/)
    await Bun.sleep(500)
    await shot('6-artifact-opened')
    await app.getByTestId('app-ready').press(`${PRIMARY}-1`); await Bun.sleep(400)
  }, { gap: GAPS.shortcut })
  console.log(`PASS ${variant}: preview, visual, question, viewer, Mermaid with no web view; opened: ${openedLines().length}`)
} catch (error) { console.log(f.diagnostics()); throw error } finally { await f.close(); server.stop(true); client.close?.() }
process.exit(0)
