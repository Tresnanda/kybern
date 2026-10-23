// ADE-69 in the full app: after a click in an inline visual or a Preview page, keys typed into the composer went to the
// page and beeped. Presses on GPUI and keys go through AppKit (local monitors, NSWindow first responder); presses in a
// page call its mouseDown directly, as a background window takes no first click. Its own scratch daemon; never ~/.kybern.
//   KYBERN_FOCUS_SCRATCH=<scratch dir> KYBERN_FOCUS_OUT=<evidence dir> bun scripts/focus-app-check.ts
// KYBERN_FOCUS_REPORT=1 records the steps without failing (the "before" run against an older webview dylib).
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { KybernClient } from '../../../packages/kybern-client/src/client.ts'
import { launchFixture } from '../src/requests/harness.ts'
import { acquirePreviewUiLock } from './preview-ui-lock.ts'
import { COMPANION_CFLAGS } from './companion-flags.ts'

const scratch = process.env.KYBERN_FOCUS_SCRATCH, out = process.env.KYBERN_FOCUS_OUT ?? scratch
if (!scratch || !out) throw Error('Set KYBERN_FOCUS_SCRATCH to a scratch directory')
const report = process.env.KYBERN_FOCUS_REPORT === '1'
const data = path.join(scratch, 'data'), project = path.join(scratch, 'project')
mkdirSync(project, { recursive: true }); mkdirSync(out, { recursive: true })
execFileSync('clang', ['-dynamiclib', ...COMPANION_CFLAGS, '-framework', 'Cocoa', path.join(import.meta.dir, '../native/webview-input.m'), '-o', path.join(import.meta.dir, '../native/build/webview-input.dylib')])
const port = 4293
const daemon = Bun.spawn([process.env.KYBERND ?? 'kybernd', '--data-dir', data, '--port', String(port)], { stdout: 'ignore', stderr: 'ignore', env: { ...process.env, PATH: '/usr/bin:/bin' } })
const release = acquirePreviewUiLock()
try {
  for (let n = 0; !existsSync(path.join(data, 'daemon.token')); n++) { if (n > 200) throw Error('Scratch daemon did not start'); await Bun.sleep(50) }
  const client = new KybernClient({ url: `ws://127.0.0.1:${port}/ws`, token: readFileSync(path.join(data, 'daemon.token'), 'utf8').trim() })
  client.connect(); while (client.status !== 'open') await Bun.sleep(30)
  const file = path.join(project, 'focus.html')
  writeFileSync(file, `<!doctype html><style>body{margin:0;padding:16px;font:14px system-ui}input{display:block;width:200px;height:32px;box-sizing:border-box}</style><input id="f" placeholder="Page field"><script>f.oninput=()=>parent.postMessage({kind:'focus-page',input:f.value},'*');parent.postMessage({kind:'focus-page',input:''},'*')</script>`)
  const { id: projectId } = await client.call('projects.add', { path: project, name: 'focus-project' })
  const thread = await client.call('threads.create', { project_id: projectId, title: 'Focus handback', provider: { kind: 'claude-code', instance: 'default' } })
  const db = new Database(path.join(data, 'state.sqlite')), turn = crypto.randomUUID(), message = crypto.randomUUID()
  db.transaction(() => {
    const insert = db.query('INSERT INTO events(thread_id,turn_id,at,kind,payload) VALUES (?,?,?,?,?)')
    for (const event of [{ kind: 'turn_started', message_id: crypto.randomUUID(), message: { parts: [{ type: 'text', text: 'Show a visual with a button and a field.' }] } }, { kind: 'assistant_message_completed', message_id: message, origin: { kind: 'root' }, text: 'Here it is.', thinking: null }, { kind: 'turn_completed', stop_reason: 'completed', usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0 }, duration_ms: 1, terminal_message_id: message }]) insert.run(thread.id, turn, new Date().toISOString(), event.kind, JSON.stringify(event))
    db.query('UPDATE threads SET last_seq=(SELECT MAX(seq) FROM events WHERE thread_id=?) WHERE id=?').run(thread.id, thread.id)
  })(); db.close()
  await client.call('threads.visuals.publish', { thread_id: thread.id, title: 'Focus visual', height: 140, html: `<!doctype html><style>body{margin:0;padding:16px;font:14px system-ui}button,input{display:block;width:200px;height:32px;box-sizing:border-box;margin:0 0 12px}</style><button id="b">Count 0</button><input id="f" placeholder="Visual field"><script>let n=0;const r=()=>parent.postMessage({kind:'focus-visual',count:n,input:f.value},'*');b.onclick=()=>{b.textContent='Count '+(++n);r()};f.oninput=r;r()</script>` })
  client.close()

  const events = path.join(scratch, 'events.jsonl'), commands = path.join(scratch, 'commands.jsonl'); writeFileSync(events, ''); writeFileSync(commands, '')
  const fixture = await launchFixture(path.join(import.meta.dir, 'focus-app.fixture.ts'), { KYBERN_DATA_DIR: data, KYBERN_URL: '', KYBERN_CLIENT_CONFIG_DIR: path.join(scratch, 'client'), KYBERN_GPUIX_CREDENTIALS_DIR: path.join(scratch, 'credentials'), KYBERN_GPUIX_THREAD: thread.id, KYBERN_APPEARANCE: 'dark', GPUIX_BACKGROUND: '1', KYBERN_FOCUS_EVENTS: events, KYBERN_FOCUS_COMMANDS: commands, KYBERN_PREVIEW_TARGET: file, KYBERN_WINDOW_SIZE: '1280x820' })
  const a = fixture.app, log = () => readFileSync(events, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  const wait = async (predicate: () => boolean, label: string) => { const deadline = Date.now() + 15000; while (!predicate()) { if (Date.now() > deadline) throw Error(`${label}: ${fixture.diagnostics()}\n${JSON.stringify(log().slice(-20))}`); await Bun.sleep(50) } }
  const send = async (command: Record<string, unknown>, settle = 250) => { appendFileSync(commands, JSON.stringify(command) + '\n'); await Bun.sleep(settle) }
  let probes = 0
  const responder = async () => { const id = ++probes; await send({ op: 'responder', id }, 0); await wait(() => log().some(e => e.type === 'responder' && e.id === id), 'responder'); return log().find(e => e.type === 'responder' && e.id === id).value as number }
  const type = async (chars: string) => { const codes: Record<string, number> = { a: 0, b: 11, h: 4, i: 34, x: 7, y: 16, z: 6 }; for (const c of chars) await send({ op: 'key', chars: c, code: codes[c] }, 120); await Bun.sleep(250) }
  const escape = () => send({ op: 'key', chars: '\u001b', code: 53 }, 500)
  // GPUI's painted text; the composer and the address field have no other text read-back.
  const painted = async () => (await a.call('getPaintedText', {})).text as string[]
  const lastPage = (kind: string) => log().filter(e => e.type === 'message' && e.data?.kind === kind).at(-1)?.data
  const steps: { step: string; ok: boolean; detail: string }[] = []
  const expect = (step: string, ok: boolean, detail: unknown) => { steps.push({ step, ok, detail: JSON.stringify(detail) }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${step}: ${JSON.stringify(detail)}`) }
  try {
    await wait(() => !!lastPage('kybern-visual-size'), 'visual layout'); await a.getByTestId('composer').waitFor(); await Bun.sleep(1200)
    const frame = await a.getByTestId('visual-frame').bounds(), composer = await a.getByTestId('composer').bounds()
    await a.screenshot({ path: path.join(out, `app-loaded-${report ? 'before' : 'after'}.png`) })
    const pressComposer = () => send({ op: 'press', x: composer.x + composer.width / 2, y: composer.y + composer.height / 2 })
    // Inline visual in the chat.
    await send({ op: 'click', x: frame.x + 100, y: frame.y + 32 }); await wait(() => lastPage('focus-visual')?.count === 1, 'visual button click')
    expect('click the visual button: the page holds the keyboard', await responder() === 1, { responder: await responder() })
    await pressComposer(); expect('click the composer: GPUI holds the keyboard', await responder() === 0, { responder: await responder() })
    await type('hi'); expect('type: the text appears in the composer', (await painted()).includes('hi'), { composer: (await painted()).filter(line => /^hi/.test(line)) })
    await send({ op: 'click', x: frame.x + 100, y: frame.y + 76 }); await type('xy')
    expect('click the visual field and type: the text goes to the page', lastPage('focus-visual')?.input === 'xy', { page: lastPage('focus-visual') })
    await escape(); expect('Escape in the visual: GPUI holds the keyboard', await responder() === 0, { responder: await responder() })
    await type('z'); expect('type after Escape: the text goes to the composer', (await painted()).includes('hiz'), { composer: (await painted()).filter(line => /^hi/.test(line)) })
    await a.screenshot({ path: path.join(out, `app-composer-${report ? 'before' : 'after'}.png`) })
    // Browser Preview tab: its address field is the GPUI text input there.
    await send({ op: 'preview' }); await a.getByTestId('dock-preview').waitFor({ timeoutMs: 15000 }); await wait(() => !!lastPage('focus-page'), 'preview page load'); await Bun.sleep(800)
    const slot = await a.getByTestId('preview-slot-dock').bounds(), address = await a.getByTestId('preview-address-rest').bounds()
    const addressText = async () => (await painted()).join('\n')
    await send({ op: 'click', x: slot.x + 100, y: slot.y + 32 }); await type('ab')
    expect('click the Preview field and type: the text goes to the page', lastPage('focus-page')?.input === 'ab', { page: lastPage('focus-page') })
    // A press on the address opens its field, which GPUIX focuses through focusElement.
    await send({ op: 'press', x: address.x + address.width / 2, y: address.y + address.height / 2 }, 600); expect('click the address field: GPUI holds the keyboard', await responder() === 0, { responder: await responder() })
    const typedFrom = await addressText(); await type('h'); expect('type: the text goes to the address field', (await addressText()) !== typedFrom && lastPage('focus-page')?.input === 'ab', { page: lastPage('focus-page') })
    await send({ op: 'click', x: slot.x + 150, y: slot.y + 32 }); await escape(); expect('Escape in the Preview page: GPUI holds the keyboard', await responder() === 0, { responder: await responder() })
    const before = await addressText(); await type('i')
    // GPUI may have no focused field once the address closes; the page must not get the key either way.
    expect('type after Escape: the text does not go to the page', lastPage('focus-page')?.input === 'ab', { page: lastPage('focus-page'), gpuiChanged: (await addressText()) !== before })
    await a.screenshot({ path: path.join(out, `app-preview-${report ? 'before' : 'after'}.png`) })
  } catch (error) { console.error(fixture.diagnostics()); throw error } finally {
    writeFileSync(path.join(out, `app-steps-${report ? 'before' : 'after'}.json`), JSON.stringify(steps, null, 2))
    await fixture.close()
  }
  if (!report) { assert.ok(steps.length === 11 && steps.every(s => s.ok), 'Focus handback failed: see the steps above'); console.log('PASS app: visual and Preview hand the keyboard back (click, Escape)') }
} finally { daemon.kill(); release() }
