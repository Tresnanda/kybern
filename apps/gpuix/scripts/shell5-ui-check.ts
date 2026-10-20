import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { launch } from '@gpuix/react/automation'
import path from 'node:path'
const root = '/Users/mymac/projects/ade-gpuix-scratch/round5/shell/ui'
const out = '/Users/mymac/projects/ade/previews/gpuix/round5/shell'
const lock = '/tmp/kybern-gpuix-round5-ui-lock', owner = '/Users/mymac/projects/ade-gpuix-shell5'
if (process.argv.includes('--matrix')) {
  await mkdir(lock); await writeFile(path.join(lock, 'owner'), owner)
  try {
    for (const flags of [[], ['--light'], ['--reduced'], ['--light', '--reduced']]) {
      const child = Bun.spawn([process.execPath, import.meta.path, ...flags], { env: { ...process.env, KYBERN_SHELL5_LOCK_HELD: '1' }, stdout: 'inherit', stderr: 'inherit' })
      assert.equal(await child.exited, 0)
    }
  } finally { if (await readFile(path.join(lock, 'owner'), 'utf8').catch(() => '') === owner) await rm(lock, { recursive: true }) }
  process.exit(0)
}
// Refuse to launch any window when another track owns the slot.
if (process.env.KYBERN_SHELL5_LOCK_HELD === '1') assert.equal(await readFile(path.join(lock, 'owner'), 'utf8'), owner)
else { await mkdir(lock); await writeFile(path.join(lock, 'owner'), owner) }
await mkdir(root, { recursive: true }); await mkdir(out, { recursive: true })
const inputs: string[] = []
const terminal = { id: 'shell5-terminal', title: 'zsh', cols: 90, rows: 24, cwd: root, alive: true }
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request, server) { if (server.upgrade(request)) return; return new Response('fixture') }, websocket: { message(ws, raw) {
  const { id, method, params = {} } = JSON.parse(String(raw)); let result: unknown = {}
  switch (method) {
    case 'daemon.info': result = { protocol_version: 1, version: 'fixture', environment_id: 'shell5-ui' }; break
    case 'projects.list': result = { projects: [] }; break
    case 'threads.list': result = { threads: [] }; break
    case 'providers.list': result = { providers: [] }; break
    case 'terminals.list': result = { terminals: [terminal] }; break
    case 'terminals.subscribe': ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'terminal.output', params: { terminal_id: terminal.id, data: Buffer.from('\x1b[?1049h\x1b[?1000;1006hMouse fixture\r\nClick and scroll here').toString('base64') } })); break
    case 'terminals.input': inputs.push(Buffer.from(params.data, 'base64').toString('utf8')); break
    case 'settings.get': result = { providers: {} }; break
    case 'skills.list': result = { skills: [] }; break
  }
  ws.send(JSON.stringify({ jsonrpc: '2.0', id, result }))
} } })
const mode = process.argv.includes('--light') ? 'light' : 'dark'
const reduced = process.argv.includes('--reduced')
let app: Awaited<ReturnType<typeof launch>> | undefined
const wait = async (test: () => boolean) => { const until = Date.now() + 5000; while (!test()) { if (Date.now() > until) throw Error('Expected terminal input did not arrive'); await Bun.sleep(30) } }
try {
  app = await launch({ command: 'bun', args: ['scripts/shell5-ui.fixture.tsx'], env: { ...process.env, GPUIX_BACKGROUND: '1', KYBERN_URL: `ws://127.0.0.1:${server.port}/ws`, KYBERN_TOKEN: 'fixture', KYBERN_DATA_DIR: root, KYBERN_CLIENT_CONFIG_DIR: root, KYBERN_GPUIX_CREDENTIALS_DIR: root, KYBERN_APPEARANCE: mode, KYBERN_REDUCED_MOTION: reduced ? '1' : '0' } })
  await app.getByTestId('terminal-mouse-screen').waitFor({ timeoutMs: 30000 })
  assert.match(await app.getByTestId('terminal-mouse-screen').textContent(), /Mouse fixture/)
  assert.match(await app.getByTestId('terminal-mouse-screen').textContent(), /Click and scroll here/)
  const bounds = await app.getByTestId('terminal-mouse-screen').bounds()
  const point = { x: bounds.x + 18, y: bounds.y + 8 }
  await app.mouse.down(point); await app.mouse.up(point)
  await wait(() => inputs.includes('\x1b[<0;3;1M') && inputs.includes('\x1b[<0;3;1m'))
  const beforeWheel = inputs.length
  await app.mouse.wheel(point, 0, 40)
  await wait(() => inputs.slice(beforeWheel).some(value => /\x1b\[<64;3;1M/.test(value)))
  const beforeShift = inputs.length
  await app.mouse.down(point, { modifiers: 'shift' }); await app.mouse.up(point, { modifiers: 'shift' })
  await Bun.sleep(100)
  assert.equal(inputs.length, beforeShift)
  await app.screenshot({ path: `${out}/terminal-${mode}${reduced ? '-reduced' : ''}.png` })
  await app.getByTestId('show-composer').click()
  await app.getByTestId('composer').fill('/resume')
  await app.getByTestId('completion').waitFor()
  assert.match(await app.getByTestId('completion').textContent(), /Continue a saved session/)
  await app.getByTestId('composer').press('enter')
  assert.match(await app.getByTestId('shell5-nav').textContent(), /"sessions":\{"projectId":null\}/)
  for (const command of ['sessions', 'settings', 'usage']) {
    await app.getByTestId('composer').fill(`/${command}`)
    await app.getByTestId('completion').waitFor()
    await app.getByTestId('composer').press('enter')
    if (command === 'settings') assert.match(await app.getByTestId('shell5-nav').textContent(), /"settings":true/)
  }
  const nav = await app.getByTestId('shell5-nav').textContent()
  assert.match(nav, /"page":"usage"/)
  await app.getByTestId('composer').fill('/')
  await app.getByTestId('completion').waitFor()
  await app.screenshot({ path: `${out}/draft-commands-${mode}${reduced ? '-reduced' : ''}.png` })
  console.log(`PASS native ${mode} reduced=${reduced}: terminal mouse down/up/wheel/Shift override and four draft commands`)
} finally {
  await app?.close(); server.stop(true)
  await rm(root, { recursive: true, force: true })
  if (process.env.KYBERN_SHELL5_LOCK_HELD !== '1' && await readFile(path.join(lock, 'owner'), 'utf8').catch(() => '') === owner) await rm(lock, { recursive: true })
}
