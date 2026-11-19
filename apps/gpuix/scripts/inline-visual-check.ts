// Inline pages in the full app (live while visible, fitted to their content, the wheel scrolls the chat). Its own scratch
// daemon (this checkout's `KYBERND`); never ~/.kybern. Wheel events carry trackpad phases and momentum through NSApp, so
// the native wheel routing in `webview.m` runs as for a real gesture; presses and drags reach the view under them.
//   KYBERN_INLINE_SCRATCH=<scratch dir> KYBERND=<checkout>/target/debug/kybernd bun scripts/inline-visual-check.ts [dark|light]
// Checks: the first press on a canvas draws (and a press on a picture is replayed whole); a 3,000 px page is not cut off;
// the wheel over a page scrolls the chat, momentum included; an inner list scrolls on its own and a continuing gesture
// stays with it, a new one at its end moves the chat; a label toggles its box without moving the chat; ⌘K opens the
// palette from a field in the page; a page scrolled away and back keeps its height; at most four pages are live.
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { KybernClient } from '../../../packages/kybern-client/src/client.ts'
import { launchFixture } from '../src/requests/harness.ts'
import { captureWindow } from '../src/transcript/live.ts'
import { acquirePreviewUiLock } from './preview-ui-lock.ts'
import { COMPANION_CFLAGS } from './companion-flags.ts'
import { BUNDLE_PAGE, CANVAS_PAGE, FORM_PAGE, LIST_PAGE, TALL_PAGE } from '../src/transcript/visual.pages.ts'

const scratch = process.env.KYBERN_INLINE_SCRATCH, out = process.env.KYBERN_INLINE_OUT ?? scratch
if (!scratch || !out) throw Error('Set KYBERN_INLINE_SCRATCH to a scratch directory')
const appearance = (process.argv[2] ?? 'dark') as 'dark' | 'light'
const data = path.join(scratch, `data-${appearance}`), project = path.join(scratch, 'project')
for (const dir of [data, path.join(scratch, `client-${appearance}`)]) rmSync(dir, { recursive: true, force: true })
mkdirSync(project, { recursive: true }); mkdirSync(out, { recursive: true }); mkdirSync(data, { recursive: true })
execFileSync('clang', ['-dynamiclib', ...COMPANION_CFLAGS, '-framework', 'Cocoa', path.join(import.meta.dir, '../native/webview-input.m'), '-o', path.join(import.meta.dir, '../native/build/webview-input.dylib')])
// Pictures need the preview browser: link the user's install so nothing is downloaded.
const BROWSER = '154.0.8037.92', installed = path.join(homedir(), '.kybern/cache/html-preview', BROWSER), linked = path.join(data, 'cache/html-preview', BROWSER)
if (existsSync(installed) && !existsSync(linked)) { mkdirSync(path.dirname(linked), { recursive: true }); symlinkSync(installed, linked) }
const port = 4297 + (appearance === 'light' ? 1 : 0)
const daemon = Bun.spawn([process.env.KYBERND ?? 'kybernd', '--data-dir', data, '--port', String(port)], { stdout: 'ignore', stderr: 'ignore', env: { ...process.env, PATH: '/usr/bin:/bin' } })
const release = acquirePreviewUiLock()
const steps: { step: string; ok: boolean; detail: string }[] = []
const expect = (step: string, ok: boolean, detail: unknown) => { steps.push({ step, ok, detail: JSON.stringify(detail) }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${step}: ${JSON.stringify(detail)}`) }
try {
  for (let n = 0; !existsSync(path.join(data, 'daemon.token')); n++) { if (n > 200) throw Error('Scratch daemon did not start'); await Bun.sleep(50) }
  const client = new KybernClient({ url: `ws://127.0.0.1:${port}/ws`, token: readFileSync(path.join(data, 'daemon.token'), 'utf8').trim() })
  client.connect(); while (client.status !== 'open') await Bun.sleep(30)
  const { id: projectId } = await client.call('projects.add', { path: project, name: 'inline-pages' })
  const thread = await client.call('threads.create', { project_id: projectId, title: 'Inline pages', provider: { kind: 'claude-code', instance: 'default' } })
  const db = new Database(path.join(data, 'state.sqlite')), turn = crypto.randomUUID(), message = crypto.randomUUID()
  const prose = Array.from({ length: 8 }, (_, i) => `Paragraph ${i + 1}: the release went out to every region; latency held under budget and the canary stayed green for the whole window.`).join('\n\n')
  db.transaction(() => {
    const insert = db.query('INSERT INTO events(thread_id,turn_id,at,kind,payload) VALUES (?,?,?,?,?)')
    for (const event of [{ kind: 'turn_started', message_id: crypto.randomUUID(), message: { parts: [{ type: 'text', text: 'Show the release dashboards.' }] } }, { kind: 'assistant_message_completed', message_id: message, origin: { kind: 'root' }, text: prose, thinking: null }, { kind: 'turn_completed', stop_reason: 'completed', usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0 }, duration_ms: 1, terminal_message_id: message }]) insert.run(thread.id, turn, new Date().toISOString(), event.kind, JSON.stringify(event))
    db.query('UPDATE threads SET last_seq=(SELECT MAX(seq) FROM events WHERE thread_id=?) WHERE id=?').run(thread.id, thread.id)
  })(); db.close()
  const ids: Record<string, string> = {}
  for (const [name, title, html] of [['short', 'Bundle size by route', BUNDLE_PAGE], ['tall', 'Latency by region', TALL_PAGE], ['list', 'Recent deploys', LIST_PAGE], ['canvas', 'Sketch pad', CANVAS_PAGE], ['form', 'Release form', FORM_PAGE]] as const)
    ids[name] = (await client.call('threads.visuals.publish', { thread_id: thread.id, title, height: 0, html })).visual.id
  client.close()
  const doc = (name: string) => `visual:${thread.id}:${ids[name]}`
  const ORDER = ['short', 'tall', 'list', 'canvas', 'form']

  const events = path.join(scratch, `events-${appearance}.jsonl`), commands = path.join(scratch, `commands-${appearance}.jsonl`); writeFileSync(events, ''); writeFileSync(commands, '')
  const fixture = await launchFixture(path.join(import.meta.dir, 'inline-visual.fixture.ts'), { KYBERN_DATA_DIR: data, KYBERN_URL: '', KYBERN_CLIENT_CONFIG_DIR: path.join(scratch, `client-${appearance}`), KYBERN_GPUIX_CREDENTIALS_DIR: path.join(scratch, 'credentials'), KYBERN_GPUIX_THREAD: thread.id, KYBERN_APPEARANCE: appearance, KYBERN_OPAQUE: '1', GPUIX_BACKGROUND: '1', KYBERN_FOCUS_EVENTS: events, KYBERN_FOCUS_COMMANDS: commands, KYBERN_WINDOW_SIZE: '1280x820' })
  const a = fixture.app, log = () => readFileSync(events, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  const wait = async (predicate: () => boolean | Promise<boolean>, label: string, ms = 15000) => { const deadline = Date.now() + ms; while (!(await predicate())) { if (Date.now() > deadline) throw Error(`${label}: ${fixture.diagnostics()}\n${JSON.stringify(log().slice(-12))}`); await Bun.sleep(50) } }
  const send = async (command: Record<string, unknown>, settle = 0) => { appendFileSync(commands, JSON.stringify(command) + '\n'); if (settle) await Bun.sleep(settle) }
  let requests = 0
  const ask = async (command: Record<string, unknown>, type: string) => { const id = ++requests; await send({ ...command, id }); await wait(() => log().some(e => e.type === type && e.id === id), type); return log().find(e => e.type === type && e.id === id) }
  const evaluate = async (name: string, script: string) => (await ask({ op: 'eval', doc: doc(name), script }, 'eval')).value
  const shot = (name: string) => captureWindow(fixture.pid, path.join(out, `inline-${name}-${appearance}.png`))
  const figures = async () => (await a.getByTestId('visual-figure').all()).map(x => x.bounds!)
  const figure = async (name: string) => (await figures())[ORDER.indexOf(name)]!
  const isLive = async (name: string) => (await ask({ op: 'docs' }, 'docs')).documents.includes(doc(name)) && log().some(e => e.id === doc(name) && e.type === 'message' && e.data?.kind === 'kybern-visual-size')
  /** One trackpad gesture at (x, y): began, `n` changes, ended, then `momentum` momentum events. */
  const gesture = async (x: number, y: number, dy: number, n = 6, momentum = 0) => {
    await send({ op: 'scroll', x, y, dy, phase: 1 }); await Bun.sleep(16)
    for (let i = 0; i < n; i++) { await send({ op: 'scroll', x, y, dy, phase: 2 }); await Bun.sleep(16) }
    await send({ op: 'scroll', x, y, phase: 4 }); await Bun.sleep(16)
    if (momentum) {
      await send({ op: 'scroll', x, y, dy, momentum: 1 }); await Bun.sleep(16)
      for (let i = 0; i < momentum; i++) { await send({ op: 'scroll', x, y, dy: dy * (1 - i / momentum), momentum: 2 }); await Bun.sleep(16) }
      await send({ op: 'scroll', x, y, momentum: 3 }); await Bun.sleep(16)
    }
    await wait(async () => (await ask({ op: 'idle' }, 'idle')).pending === 0, 'wheel events sent')
    await Bun.sleep(400)
  }
  /** Bring a figure's top into view by scrolling the chat (GPUI-level wheel, away from any page). */
  const reveal = async (name: string, top = 120) => {
    for (let i = 0; i < 40; i++) {
      const b = await figure(name), off = b.y - top
      if (Math.abs(off) < 30) return
      await a.mouse.wheel({ x: 400, y: 400 }, 0, Math.max(-600, Math.min(600, -off))); await Bun.sleep(250)
    }
  }

  await a.getByTestId('visual-picture').waitFor({ timeoutMs: 30000 }); await Bun.sleep(1500)
  await wait(() => log().some(e => e.type === 'created'), 'a page went live without a press')
  await wait(async () => isLive('form'), 'the form, on screen, is live', 20000); await Bun.sleep(800)
  shot('1-bottom')

  // The wheel over a page scrolls the chat, with momentum.
  await reveal('form', 300); await wait(async () => isLive('form'), 'form live'); await Bun.sleep(600)
  // Over the middle of the page, so the pointer stays on it: every delta of the gesture moves the chat (7 × 12 pt).
  const form = await figure('form')
  await gesture(form.x + form.width - 60, form.y + form.height / 2, 12, 6)
  const afterGesture = await figure('form')
  expect('the wheel over a page scrolls the chat by the whole gesture', Math.abs(afterGesture.y - form.y - 84) <= 1, { before: form.y, after: afterGesture.y })
  // Momentum after the fingers lift: 12 decaying packets (78 pt) beyond the gesture's 5 × 12.
  await gesture(afterGesture.x + afterGesture.width - 60, afterGesture.y + afterGesture.height / 2, 12, 4, 12)
  const afterMomentum = await figure('form')
  expect('momentum keeps scrolling the chat', afterMomentum.y - afterGesture.y >= 60 + 50, { before: afterGesture.y, after: afterMomentum.y })

  // The canvas: the first press draws, a drag strokes it.
  await reveal('canvas', 160); await wait(async () => isLive('canvas'), 'canvas live'); await Bun.sleep(600)
  const canvas = await figure('canvas')
  await send({ op: 'drag', x: canvas.x + 80, y: canvas.y + 60, x2: canvas.x + 320, y2: canvas.y + 160, steps: 10 }, 600)
  const pad = JSON.parse(await evaluate('canvas', "document.getElementById('pad').dataset.state") as string)
  expect('the first press and drag on a canvas reach it', pad.downs === 1 && pad.moves >= 5 && pad.strokes === 1, pad)
  await send({ op: 'send', doc: doc('canvas'), data: { kind: 'kybern-visual-click', x: 200, y: 100 } }, 500)
  const replayed = JSON.parse(await evaluate('canvas', "document.getElementById('pad').dataset.state") as string)
  expect('a press on the picture is replayed whole (pointer down and up)', replayed.downs === 2 && replayed.ups === 2, replayed)
  shot('2-canvas')

  // The form: a label toggles its box and the chat stays put.
  await reveal('form', 200); await wait(async () => isLive('form'), 'form live'); await Bun.sleep(600)
  const formBox = await figure('form')
  const labelBox = await evaluate('form', "(()=>{const r=document.getElementById('notify-label').getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()") as number[]
  await send({ op: 'click', x: formBox.x + labelBox[0]!, y: formBox.y + labelBox[1]! }, 500)
  const checked = await evaluate('form', "document.getElementById('notify').checked")
  const formAfter = await figure('form')
  expect('a label press toggles its box and does not move the chat', checked === true && Math.abs(formAfter.y - formBox.y) < 1, { checked, before: formBox.y, after: formAfter.y })
  // ⌘K from a field in the page opens the palette; the field keeps its own keys.
  const field = await evaluate('form', "(()=>{const r=document.getElementById('name').getBoundingClientRect();return [r.left+20,r.top+r.height/2]})()") as number[]
  await send({ op: 'click', x: formBox.x + field[0]!, y: formBox.y + field[1]! }, 400)
  const responder = (await ask({ op: 'responder' }, 'responder')).value
  await send({ op: 'chord', chars: 'k', code: 40, flags: 1 << 20 }, 600)
  const palette = await a.getByTestId('palette').count()
  expect('⌘K from a field in the page opens the palette', responder === 1 && palette > 0, { responder, palette })
  shot('3-form-palette')
  if (palette) { await a.getByTestId('palette-input').press('escape'); await Bun.sleep(400) }

  // The inner list takes the wheel; a continuing gesture stays with it; a new one at its end moves the chat.
  await reveal('list', 160); await wait(async () => isLive('list'), 'list live'); await Bun.sleep(800)
  const listRect = await evaluate('list', "(()=>{const r=document.getElementById('list').getBoundingClientRect();return [r.left,r.top,r.width,r.height]})()") as number[]
  let listFig = await figure('list')
  const over = { x: listFig.x + listRect[0]! + listRect[2]! / 2, y: listFig.y + listRect[1]! + listRect[3]! / 2 }
  await gesture(over.x, over.y, -20, 5)
  const scrolled = await evaluate('list', "document.getElementById('list').scrollTop") as number
  const listAfter = await figure('list')
  expect('the wheel over an inner list scrolls the list, not the chat', scrolled > 40 && Math.abs(listAfter.y - listFig.y) < 1, { scrollTop: scrolled, before: listFig.y, after: listAfter.y })
  // One long gesture: the list reaches its end and the rest of the gesture does not spill into the chat.
  listFig = await figure('list')
  await gesture(over.x, over.y, -120, 30, 20)
  const atEnd = await evaluate('list', "(()=>{const l=document.getElementById('list');return l.scrollTop+l.clientHeight>=l.scrollHeight-1})()")
  const afterLong = await figure('list')
  expect('a continuing gesture stays with the list at its end', atEnd === true && Math.abs(afterLong.y - listFig.y) < 1, { atEnd, before: listFig.y, after: afterLong.y })
  await Bun.sleep(400)
  await gesture(over.x, over.y, -20, 5)
  const afterNew = await figure('list')
  expect('a new gesture at the list end scrolls the chat', listFig.y - afterNew.y > 40, { before: listFig.y, after: afterNew.y })
  // A mouse wheel (no phases) over the page but outside the list scrolls the chat.
  const plain = await figure('list')
  for (let i = 0; i < 3; i++) await send({ op: 'scroll', x: plain.x + 40, y: plain.y + 10, dy: 30 })
  await Bun.sleep(800)
  expect('a mouse wheel outside the list scrolls the chat', (await figure('list')).y - plain.y > 40, { before: plain.y, after: (await figure('list')).y })
  shot('4-list')

  // The tall page: nothing cut off, its last line reachable.
  await reveal('tall', 140); await wait(async () => isLive('tall'), 'tall live'); await Bun.sleep(800)
  const tall = await figure('tall')
  const content = await evaluate('tall', "Math.ceil(document.getElementById('end').getBoundingClientRect().bottom)") as number
  expect('a 3,000 px page is as tall as its content', tall.height >= content && tall.height < content + 40 && tall.height > 2900, { figure: tall.height, contentBottom: content })
  shot('5-tall-top')
  const end = await figure('tall')
  await a.mouse.wheel({ x: 400, y: 400 }, 0, -(end.height - 500)); await Bun.sleep(800)
  shot('6-tall-end')
  // Scrolled far away and back: the same height, no jump.
  const heightBefore = (await figure('tall')).height
  await reveal('form', 300); await Bun.sleep(600); await reveal('short', 150); await Bun.sleep(600); await reveal('tall', 140); await Bun.sleep(1000)
  const heightAfter = (await figure('tall')).height
  expect('a page scrolled away and back keeps its height', Math.abs(heightAfter - heightBefore) < 1, { before: heightBefore, after: heightAfter })
  const docs = await ask({ op: 'docs' }, 'docs')
  expect('at most four pages are live', docs.live <= 4 && docs.documents.length <= 5, docs)
  console.log(`${steps.filter(s => s.ok).length}/${steps.length} passed`)
  assert.ok(steps.every(s => s.ok), steps.filter(s => !s.ok).map(s => s.step).join('; '))
  await fixture.close()
} finally {
  release(); daemon.kill()
  writeFileSync(path.join(out, `inline-steps-${appearance}.json`), JSON.stringify(steps, null, 2))
}
process.exit(0)
