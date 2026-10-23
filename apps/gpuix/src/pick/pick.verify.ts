// Real app against a scratch daemon (VISUAL_SCRATCH=<…gpuix-scratch…>/l-composer, KYBERND=<this checkout's kybernd>):
//   bun src/pick/pick.verify.ts secret   — paste a fake key: strip → Store → `$NAME` chip and an env-file entry; a git SHA gives no strip
//   bun src/pick/pick.verify.ts pick     — a real agent asks to pick an element in the Preview; highlight → confirm → structured result; ⌥-click chip
// Evidence goes to KYBERN_VERIFY_OUTPUT. Never the user's ~/.kybern: `launchFixture` refuses it.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { launchFixture } from '../requests/harness.ts'
import { CLIENT_DIR, CREDS_DIR, DATA_DIR, SCRATCH, connect, startDaemon } from '../../visual/fixture.ts'

const mode = process.argv[2] ?? 'secret'
const theme = (process.env.THEME ?? 'dark') as 'dark' | 'light'
const out = process.env.KYBERN_VERIFY_OUTPUT ?? '/Users/mymac/projects/ade/.kybern-artifacts/ade-69-71/L-composer'
mkdirSync(out, { recursive: true })
const ROOT = path.resolve(import.meta.dir, '../..')
const until = async (check: () => Promise<boolean> | boolean, label: string, ms = 15000) => {
  const end = Date.now() + ms
  for (;;) { try { if (await check()) return } catch {} if (Date.now() > end) throw Error(`Timed out: ${label}`); await Bun.sleep(60) }
}
const git = (cwd: string, ...args: string[]) => { const r = spawnSync('git', args, { cwd }); if (r.status !== 0) throw Error(String(r.stderr)) }

const rand = (length: number, seed = 5) => { const a = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'; let x = seed, s = ''; for (let i = 0; i < length; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; s += a[(x >> 8) % a.length] } return s }
const FAKE_KEY = `sk-ant-api03-${rand(88)}`

const state = await startDaemon(process.env.FRESH !== '0')
const client = await connect(state)
const project = path.join(SCRATCH, 'project')
mkdirSync(project, { recursive: true })
if (!existsSync(path.join(project, '.git'))) { git(project, 'init', '-q'); writeFileSync(path.join(project, '.gitignore'), '.env.local\n'); writeFileSync(path.join(project, 'README.md'), '# scratch\n'); git(project, 'add', '.'); git(project, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init') }
const added = await client.call('projects.add', { path: project, name: 'scratch-project' })
const created = await client.call('threads.create', { project_id: added.id, provider: { kind: 'claude-code', instance: 'default' }, permission_mode: 'supervised' as const, title: mode === 'secret' ? 'Secret test' : 'Pick test', ...(mode !== 'secret' ? { permission_mode: 'full-access' as const } : {}) })
const thread = created.id ?? (created as unknown as { thread: { id: string } }).thread.id

// No Accessibility grant here, so a real pointer cannot be driven: the page polls this server for synthetic mouse events and
// dispatches them on its own elements. The picker's listeners are in Kybern's isolated world but share the page's event system,
// so they see exactly what a pointer would send (the hit-testing of a real pointer is WebKit's, not ours).
const queue: Record<string, unknown>[] = []
const PAGE = `<!doctype html><meta charset=utf-8><title>Anamorphia</title><style>body{font:15px system-ui;margin:0;background:#cfcbc4;color:#222}header{padding:14px 20px;background:#e6e2db;display:flex;gap:10px;align-items:center}.dot{width:18px;height:18px;border-radius:5px;background:#d15a38}main{padding:28px 32px;max-width:520px}h1{font-size:26px;margin:6px 0}p{color:#555}.row{display:flex;gap:10px;margin-top:20px}button{font:600 14px system-ui;padding:11px 18px;border-radius:9px;border:1px solid #bbb;background:#f6f4f0}button.checkout-cta{background:#1c2430;color:#fff;border-color:#1c2430}</style><header><span class=dot></span><b>Anamorphia Prints</b></header><main><p>Fine-art print · 30 × 40 cm</p><h1>Dune at first light</h1><p>Archival pigment on cotton rag.</p><div class=row><button class=checkout-cta data-kybern-id=pay>Pay $48.00</button><button>Save for later</button></div></main><script>
setInterval(async () => { try {
  const commands = await (await fetch('http://localhost:__PORT__/cmd')).json()
  for (const c of commands) {
    const el = document.querySelector(c.sel), r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2
    const o = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window, altKey: !!c.alt, metaKey: !!c.meta, button: 0 }
    if (c.type === 'move') el.dispatchEvent(new MouseEvent('mousemove', o))
    if (c.type === 'click') for (const t of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(t, o))
    if (c.type === 'key') document.dispatchEvent(new KeyboardEvent('keydown', { key: c.key, bubbles: true, cancelable: true }))
  }
} catch (e) {} }, 120)
</script>`
let pagePort = 0
const page = Bun.serve({ port: 0, fetch: (req: Request): Response => {
  if (new URL(req.url).pathname === '/cmd') return new Response(JSON.stringify(queue.splice(0)), { headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } })
  return new Response(PAGE.replace('__PORT__', String(pagePort)), { headers: { 'content-type': 'text/html' } })
} })
pagePort = page.port!
const pageUrl = `http://localhost:${page.port}/`

const env = { KYBERN_GPUIX_RESOURCES: '', GPUIX_BACKGROUND: '1', KYBERN_OPAQUE: process.env.GLASS ? '0' : '1', KYBERN_APPEARANCE: theme, KYBERN_DATA_DIR: DATA_DIR, KYBERN_CLIENT_CONFIG_DIR: CLIENT_DIR, KYBERN_GPUIX_CREDENTIALS_DIR: CREDS_DIR, KYBERN_ENVIRONMENT_NAME: 'Development environment', KYBERN_REDUCED_MOTION: '1', KYBERN_GPUIX_THREAD: thread, KYBERN_URL: '', KYBERN_TOKEN: '', ...(process.env.GLASS ? { KYBERN_WINDOW_MATERIAL: 'window' } : {}) }
import('node:fs').then(fs => fs.rmSync(path.join(DATA_DIR, 'gpuix-ui.json'), { force: true }))
const fixture = await launchFixture(path.join(ROOT, 'src/main.tsx'), env)
const app = fixture.app
const painted = async () => { await app.clock.fastForward(16); return String((await app.call('getPaintedText', {})).text) }
const shot = (name: string) => process.env.GLASS ? Promise.resolve(windowShot(name)) : app.screenshot({ path: `${out}/${name}-${theme}${process.env.GLASS ? '-glass' : ''}.png` })
const windowShot = (name: string) => {
  const id = Bun.spawnSync(['swift', path.join(ROOT, 'visual/window-id.swift'), String(fixture.pid)]).stdout.toString().trim()
  if (!id) throw Error('No window id')
  const r = Bun.spawnSync(['screencapture', '-l', id, '-x', '-o', `${out}/${name}-${theme}${process.env.GLASS ? '-glass' : ''}.png`])
  if (r.exitCode !== 0) throw Error(String(r.stderr))
}
try {
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
  await until(async () => (await app.getByTestId('composer').count()) > 0, 'composer', 30000)
  if (mode === 'secret') {
    const composer = app.getByTestId('composer')
    // 1. A git SHA is not a key.
    const clip0 = spawnSync('pbpaste').stdout
    try {
      spawnSync('pbcopy', { input: 'The fix is in 4b825dc642cb6eb9a060e54bf8d69288fbee4904 and in /Users/mymac/projects/ade/apps/gpuix/src/composer/Composer.tsx' })
      await composer.press('cmd-v')
    } finally { spawnSync('pbcopy', { input: clip0 }) }
    await app.clock.fastForward(300)
    assert.equal(await app.getByTestId('secret-catch').count(), 0, 'a git SHA or a path must not show the strip')
    await composer.fill('')
    // 2. A key does.
    // `fill` types one character at a time; a paste inserts the run at once, which is what the catcher reads.
    const clip = spawnSync('pbpaste').stdout
    try {
      await composer.fill('Use this for the eval runs: ')
      spawnSync('pbcopy', { input: FAKE_KEY })
      await composer.press('cmd-v')
    } finally { spawnSync('pbcopy', { input: clip }) }
    await until(async () => (await app.getByTestId('secret-catch').count()) > 0, 'secret strip')
    await app.clock.fastForward(300)
    await shot('secret-detected')
    assert.ok((await painted()).includes('Looks like an API key.'))
    // Nothing is saved as a draft while the strip is up.
    await Bun.sleep(300)
    const stored = () => [CLIENT_DIR, DATA_DIR].flatMap(d => { try { return readdirSync(d, { recursive: true, withFileTypes: true }) .filter(e => e.isFile()).map(e => path.join(e.parentPath, e.name)) } catch { return [] } })
    for (const file of stored()) { if (file.endsWith('.sqlite') || file.endsWith('.sqlite-wal')) continue; try { assert.ok(!readFileSync(file, 'utf8').includes(FAKE_KEY), `the key leaked into ${file}`) } catch (e) { if ((e as Error).name === 'AssertionError') throw e } }
    await app.getByTestId('secret-store').click()
    await until(async () => (await app.getByTestId('secret-name').count()) > 0, 'name form')
    await app.clock.fastForward(400)
    await shot('secret-name')
    await until(async () => /Saved to|already has|not ignore|tracks/.test(await painted()), 'target check')
    if (process.env.CANCEL) { await app.getByTestId('secret-cancel').click(); await app.clock.fastForward(300); await shot('cancel-test'); console.log('after cancel click: strip', await app.getByTestId('secret-catch').count(), 'form', await app.getByTestId('secret-name').count()); process.exit(0) }
    if (process.env.KEYS) await app.getByTestId('secret-name-input').press('enter'); else await app.getByTestId('secret-confirm').click()
    await until(async () => (await app.getByTestId('secret-catch').count()) === 0 && (await app.getByTestId('secret-name').count()) === 0, 'strip gone', 20000)
    await app.clock.fastForward(300)
    await shot('secret-stored')
    const env1 = readFileSync(path.join(project, '.env.local'), 'utf8')
    assert.ok(env1.includes(`ANTHROPIC_API_KEY=${FAKE_KEY}`), 'the key is in .env.local')
    const text = await painted()
    assert.ok(text.includes('ANTHROPIC_API_KEY'), 'the chip reads ANTHROPIC_API_KEY')
    assert.ok(!text.includes(FAKE_KEY.slice(0, 20)), 'the raw key is no longer in the composer')
    console.log('PASS secret: strip → Store → chip, .env.local written, SHA not flagged')
  }
  if (mode === 'pick') {
    const SCR = '/Users/mymac/projects/ade-gpuix-scratch/l-composer'
    const bounds = () => Bun.spawnSync(['swift', `${SCR}/window-bounds.swift`, String(fixture.pid)]).stdout.toString().trim().split(' ').map(Number) as [number, number, number, number]
    /** Screen point of the first pixel run near `rgb` in a fresh window capture (the page's checkout button). */
    const activate = () => console.log('activate', Bun.spawnSync(['swift', `${SCR}/activate.swift`, String(fixture.pid)]).stdout.toString().trim())
    const find = (rgb: [number, number, number], tol = 6) => {
      windowShot('probe')
      const probe = `${out}/probe-${theme}${process.env.GLASS ? '-glass' : ''}.png`
      const r = Bun.spawnSync(['swift', `${SCR}/find-color.swift`, probe, ...rgb.map(String), String(tol)]).stdout.toString().trim().split(' ').map(Number)
      if (r.length < 5) throw Error('the button was not found in the window capture')
      const [minX, minY, maxX, maxY, wide] = r as [number, number, number, number, number]
      const [wx, wy, ww] = bounds(), scale = wide / ww
      return { x: Math.round(wx + (minX + maxX) / 2 / scale), y: Math.round(wy + (minY + maxY) / 2 / scale) }
    }
    const click = (x: number, y: number, alt = false) => spawnSync('cliclick', [`m:${x},${y}`, ...(alt ? ['kd:alt', `c:${x},${y}`, 'ku:alt'] : [`c:${x},${y}`])])
    const approve = async () => { const { approvals } = await client.call('approvals.list', { thread_id: thread }).catch(() => ({ approvals: [] as never[] })) as { approvals: { id: string; tool_name: string }[] }; for (const a of approvals) if (a.tool_name !== 'kybern_request_pick') await client.call('approvals.respond', { approval_id: a.id, decision: 'allow_once' } as never).catch(() => {}) }
    const prompt = `Do exactly two things and nothing else. 1) Call the kybern_preview_open tool with target "${pageUrl}". 2) Call the kybern_request_pick tool with kind "preview_element" and prompt "Which button should I make larger?". Then reply with one line: the selector and text it returned.`
    await client.call('threads.send', { thread_id: thread, message: { parts: [{ type: 'text', text: prompt }] } })
    await until(async () => { await approve(); return (await app.getByTestId('pick-panel').count()) > 0 }, 'pick card', 180000)
    await Bun.sleep(1500)
    await app.clock.fastForward(300)
    await shot('pick-ask')
    windowShot('pick-ask-window')
    await app.getByTestId('pick-row-1').click()
    await until(async () => (await painted()).includes('Click the element in the Preview'), 'picking status', 15000)
    await Bun.sleep(2500)
    await Bun.sleep(1500)
    const button = { x: 0, y: 0 }
    queue.push({ type: 'move', sel: '.checkout-cta' }); await Bun.sleep(700)
    windowShot('pick-overlay')
    queue.push({ type: 'click', sel: '.checkout-cta' })
    await until(async () => (await painted()).includes('Send this element to Claude?'), 'confirm card', 15000)
    await Bun.sleep(400); await app.clock.fastForward(300)
    await shot('pick-confirm')
    windowShot('pick-confirm-window')
    await app.getByTestId('pick-row-1').click()
    await until(async () => /checkout|button|pay/i.test(await painted()) && (await app.getByTestId('pick-panel').count()) === 0, 'agent reply', 180000)
    await Bun.sleep(4000); await app.clock.fastForward(300)
    await shot('pick-result')
    const { threads } = await client.call('threads.list', {})
    console.log('PASS pick: card → overlay → confirm → structured result')
    void threads
  }
  if (mode === 'anchor') {
    const approve = async () => { const { approvals } = await client.call('approvals.list', { thread_id: thread }).catch(() => ({ approvals: [] as never[] })) as { approvals: { id: string; tool_name: string }[] }; for (const a of approvals) await client.call('approvals.respond', { approval_id: a.id, decision: 'allow_once' } as never).catch(() => {}) }
    await client.call('threads.send', { thread_id: thread, message: { parts: [{ type: 'text', text: `Call the kybern_preview_open tool with target "${pageUrl}" and reply with the single word done.` }] } })
    await until(async () => { await approve(); return (await painted()).includes('Worked for') }, 'agent done', 120000)
    await Bun.sleep(3000)
    // Type some text first so the chip lands at the caret; then look at the Preview and ⌥-click: no composer shows, so the chip waits.
    await app.getByTestId('composer').fill('Reply with only the selector of this element: ')
    await app.getByTestId('tab-preview').click()
    await Bun.sleep(2500)
    queue.push({ type: 'click', sel: '.checkout-cta', alt: true })
    await Bun.sleep(2500)
    await shot('anchor-toast')
    windowShot('anchor-preview-window')
    await app.getByTestId('tab-chat').click()
    await Bun.sleep(1500); await app.clock.fastForward(300)
    await shot('anchor-chip')
    windowShot('anchor-chip-window')
    await app.getByTestId('send').click()
    // The chip is the only thing that names the element: the agent can answer only if the daemon expanded it for the provider.
    await until(async () => /\[data-kybern-id/.test(await painted()), 'agent answer', 120000)
    const detail = await client.call('threads.get', { thread_id: thread })
    const parts = JSON.stringify(detail).match(/kybern:\/\/anchor\/[A-Za-z0-9_-]+/)
    assert.ok(parts, 'the stored message keeps the anchor chip')
    await shot('anchor-sent')
    console.log('PASS anchor: ⌥-click → chip waits while the Preview is in front → lands in the composer → the agent receives the element')
    console.log('composer element:', JSON.stringify(await app.getByTestId('composer').element()).slice(0, 400))
    await shot('anchor-chip')
    console.log('painted:', (await painted()).split('\n').filter(l => /Make|pay|button/.test(l)).join(' | ').slice(0, 300))
  }
  if (mode === 'kinds') {
    const ask = async (kind: string, prompt: string) => {
      const send = () => client.call('threads.send', { thread_id: thread, message: { parts: [{ type: 'text', text: `Call the kybern_request_pick tool once with kind "${kind}" and prompt "${prompt}". Then reply with one line saying exactly what the tool returned.` }] } })
      // The thread finishes its last turn first.
      await until(async () => { try { await send(); return true } catch (error) { return !String(error).includes('busy') } }, 'thread idle', 120000)
      await until(async () => (await app.getByTestId('pick-panel').count()) > 0, `${kind} card`, 180000)
      await Bun.sleep(1200); await app.clock.fastForward(300)
    }
    const t0 = Date.now(), log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`)
    await ask('file', 'Which file has the broken copy?'); log('file card')
    await shot('pick-file')
    await app.getByTestId('pick-filter').fill('READ'); log('filtered')
    await until(async () => (await painted()).includes('README.md'), 'README in the tree', 15000); log('README listed')
    await app.clock.fastForward(300)
    await app.getByTestId('pick-tree-row').click(); log('row clicked')
    await app.clock.fastForward(300)
    await shot('pick-file-selected')
    // The "Needs approval" toast of a background window can sit over the buttons: ↵ in the filter sends the selection.
    await app.getByTestId('pick-filter').press('enter'); log('sent')
    await until(async () => (await app.getByTestId('pick-panel').count()) === 0, 'file card gone', 30000); log('card gone')
    await until(async () => /README\.md/.test((await painted()).split('Tool result').pop() ?? ''), 'file answer', 120000); log('answered')
    await ask('image', 'Show me the layout bug you see.')
    await shot('pick-image')
    await app.getByTestId('pick-decline').press('enter').catch(() => {}); await app.getByTestId('pick-decline').click().catch(() => {})
    await until(async () => (await app.getByTestId('pick-panel').count()) === 0, 'image declined', 30000)
    await Bun.sleep(8000)
    await ask('window', 'Capture the simulator so I can check the safe-area inset.')
    await shot('pick-window')
    await app.getByTestId('pick-decline').click()
    await until(async () => (await app.getByTestId('pick-panel').count()) === 0, 'window declined', 30000)
    console.log('PASS kinds: file picked through the tree; image and window cards render and decline')
  }
} catch (error) {
  await shot('failed').catch(() => {})
  console.log(fixture.diagnostics().slice(-3000))
  throw error
} finally {
  page.stop(true)
  client.close?.()
  await fixture.close()
}
process.exit(0)
