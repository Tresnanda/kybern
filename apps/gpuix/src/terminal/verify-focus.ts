/**
 * Click-to-type and drag selection in an in-thread terminal tab, against a scratch daemon (never ~/.kybern). Each case
 * moves focus away (the chat's composer in the next group, another tab, a window blur), clicks a grid row with the real
 * pointer path, then types with window-level keystrokes that go to whatever holds focus. The shell creates a file per
 * case, so every assertion is on a command the shell really ran. Drags across rows, down and up, copy what they cover.
 * The app reaches the daemon through a local proxy, so the check can drop its connection and see the terminal recover.
 * The clipboard is saved and restored.
 *
 *   KYBERN_DATA_DIR=<scratch> KYBERN_CLIENT_CONFIG_DIR=<scratch> bun src/terminal/verify-focus.ts [theme] [out dir]
 */
import { readFileSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import assert from 'node:assert/strict'
import { launch } from '@gpuix/react/automation'
import { KybernClient } from '../../../../packages/kybern-client/src/client.ts'

const data = process.env.KYBERN_DATA_DIR, client_dir = process.env.KYBERN_CLIENT_CONFIG_DIR
if (!data || !client_dir) throw new Error('Set KYBERN_DATA_DIR and KYBERN_CLIENT_CONFIG_DIR to scratch folders.')
for (const dir of [data, client_dir]) if (path.resolve(dir) === path.join(os.homedir(), '.kybern') || !path.resolve(dir).includes('gpuix-scratch')) throw new Error(`${dir} is not a scratch folder; refusing to touch the real environment.`)
const theme = process.argv[2] === 'light' ? 'light' : 'dark'
const out = process.argv[3] ?? path.join(data, 'verify-focus')
mkdirSync(out, { recursive: true })
const port = readFileSync(`${data}/daemon.port`, 'utf8').trim(), token = readFileSync(`${data}/daemon.token`, 'utf8').trim()
const client = new KybernClient({ url: `ws://127.0.0.1:${port}/ws`, token }, { createSocket: (url, key) => new WebSocket(url, { headers: { origin: 'tauri://localhost', Authorization: `Bearer ${key}` } } as unknown as string[]) })
const ready = new Promise<void>(resolve => client.onStatus(s => { if (s === 'open') resolve() })); client.connect(); await ready
const project = (await client.call('projects.list', {})).projects.find(p => p.name === 'scratch-project')!
const thread = await client.call('threads.create', { project_id: project.id, title: `Terminal focus ${Date.now()}`, provider: { kind: 'claude-code', instance: 'default' }, model: 'claude-haiku-5-5' })
const terminal = await client.call('terminals.create', { thread_id: thread.id, cols: 100, rows: 24 })
const file = (name: string) => path.join(project.path, name)
writeFileSync(file('notes.md'), '# Notes\n')
// The chat in one group, a file tab and the terminal tab (active) in the next: the layout of the user's report.
const leaf = (id: string) => ({ kind: 'leaf', id, threadId: thread.id })
writeFileSync(path.join(data, 'gpuix-ui.json'), JSON.stringify({
  'kybern.tabs.threads': [],
  'kybern.split-view.v2': { version: 2, root: { kind: 'split', id: 's1', direction: 'horizontal', first: leaf('a'), second: leaf('b'), ratio: 0.45 }, focusedPaneId: 'a', groups: {
    a: { threadId: thread.id, tabs: [{ kind: 'chat' }], active: 'chat', preview: null },
    b: { threadId: thread.id, tabs: [{ kind: 'file', path: 'notes.md', root: 'project' }, { kind: 'terminal', id: terminal.id }], active: `terminal:${terminal.id}`, preview: null },
  } },
}))
// The app's socket goes through this proxy, so the check can cut it while the daemon and its shells live on.
const sockets = new Set<net.Socket>()
const proxy = net.createServer(down => {
  const up = net.connect(Number(port), '127.0.0.1')
  for (const socket of [down, up]) { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}) }
  down.pipe(up); up.pipe(down)
})
await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
const proxyPort = (proxy.address() as net.AddressInfo).port
// An explicit endpoint is never restarted by the app, so a rebuilt kybernd in this checkout cannot drop the session mid-check.
const app = await launch({ command: 'bun', args: [path.resolve(import.meta.dir, '../main.tsx')], env: { ...process.env, GPUIX_BACKGROUND: '1', KYBERN_OPAQUE: '1', KYBERN_APPEARANCE: theme, KYBERN_DATA_DIR: data, KYBERN_CLIENT_CONFIG_DIR: client_dir, KYBERN_GPUIX_CREDENTIALS_DIR: path.join(client_dir, 'credentials'), KYBERN_URL: `ws://127.0.0.1:${proxyPort}/ws`, KYBERN_TOKEN: token, KYBERN_REDUCED_MOTION: '1', KYBERN_WINDOW_SIZE: '1440x900' } })
const settle = (ms = 700) => new Promise(r => setTimeout(r, ms))
const until = async (what: string, ok: () => boolean, ms = 6000) => { const end = Date.now() + ms; while (Date.now() < end) { if (ok()) return; await settle(100) } throw new Error(`timed out waiting for ${what}`) }
const pid = (await app.call('initialize', { protocolVersion: 1, client: 'terminal-focus' })).pid as number
const windowId = () => execFileSync('swift', [path.resolve(import.meta.dir, '../../visual/window-id.swift'), String(pid)], { encoding: 'utf8' }).trim()
const shot = (name: string) => execFileSync('screencapture', ['-l', windowId(), '-x', path.join(out, `${name}-${theme}-gpuix.png`)])
const CELL = 7, ROW = 21.5
const input = (text: string) => client.call('terminals.input', { terminal_id: terminal.id, data: Buffer.from(text).toString('base64') })
/** Window-level keystrokes: they go to the focused element, as a person's typing does. */
const type = (text: string) => app.call('keystrokes', { keys: [...text].map(c => c === ' ' ? 'space' : c).concat('enter').join(' ') })
const markers = ['focus-first', 'focus-composer', 'focus-tabs', 'focus-blur', 'focus-again', 'focus-reconnect', 'focus-drag']
const clipboard = execFileSync('pbpaste', { encoding: 'buffer' })
const results: Record<string, unknown> = {}
try {
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 }); await settle(1500)
  const screen = app.getByTestId('terminal-screen')
  await screen.waitFor({ timeoutMs: 30_000 }); await settle(1200)
  for (const m of markers) rmSync(file(m), { force: true })
  await input(`cd ${project.path}; clear; printf 'origin%smark\\n' -; seq 1 12\r`); await settle(800)
  // Cells are placed from a printed row (the screen's own bounds may include its padding), read again before each gesture: the
  // split settles its widths after the first frames. Row 6 holds "6", a printed row (the marker is row 0); row 16 is an empty grid row. Both are row
  // elements, as is every cell the user can see.
  let mark = 'origin-mark'
  const cellAt = async (column: number, row: number) => { const b = await app.getByText(mark).bounds(); return { x: b.x + column * CELL + 1, y: b.y + row * ROW + ROW / 2 } }
  const textRow = [20, 6] as const, emptyRow = [40, 16] as const
  const clickTyping = async (name: string, at: readonly [number, number], away: () => Promise<void>) => {
    await away(); await settle(400)
    await app.mouse.click(await cellAt(...at)); await settle(300)
    await type(`touch ${name}`)
    try { await until(`${name} from typing after a click`, () => existsSync(file(name))) } catch (e) { shot(`fail-${name}`); throw e }
    results[name] = 'typed'
    console.log(`[terminal-focus] PASS ${name}`)
  }
  const composer = async () => { await app.mouse.click(await app.getByTestId('composer').center()) }

  // 1. The composer in the chat group had focus; a click on a printed row takes it.
  await clickTyping('focus-first', textRow, composer)
  // 2. The same from an empty grid row.
  await clickTyping('focus-composer', emptyRow, composer)
  // 3. Away to the file tab and back to the terminal tab, then a click on a row.
  await clickTyping('focus-tabs', textRow, async () => {
    await app.getByTestId('tab-file:project:notes.md').click(); await settle(500)
    await app.getByTestId(`tab-terminal:${terminal.id}`).click(); await settle(1200)
    await composer()
  })
  // 4. The window's focus dropped (what a window switch leaves), then a click.
  await clickTyping('focus-blur', textRow, async () => { await app.call('blur', {}) })
  // 5. A second click on the already focused terminal keeps it.
  await clickTyping('focus-again', textRow, async () => {})
  await settle(300); shot('focus')

  // 6. A drag from the first printed row to the end of the third selects all three; ⌘C copies them.
  await input('clear; printf "alph%s one\\nbravo two\\ncharlie three\\n" a\r'); await settle(900)
  mark = 'alpha one'
  execFileSync('pbcopy', { input: 'untouched' })
  await app.mouse.drag(await cellAt(0, 0), await cellAt(13, 2), { steps: 8 }); await settle(300); shot('drag-select')
  await app.call('keystrokes', { keys: 'cmd-c' }); await settle(300)
  results.dragRows = execFileSync('pbpaste', { encoding: 'utf8' })
  assert.equal(results.dragRows, 'alpha one\nbravo two\ncharlie three', 'a drag over three rows selects them and ⌘C copies them')
  console.log('[terminal-focus] PASS drag across rows')
  // 7. Upward: the selection runs from the press back to where the drag ends, a row above.
  execFileSync('pbcopy', { input: 'untouched' })
  await app.mouse.drag(await cellAt(5, 1), await cellAt(0, 0), { steps: 6 }); await settle(300)
  await app.call('keystrokes', { keys: 'cmd-c' }); await settle(300)
  results.dragUp = execFileSync('pbpaste', { encoding: 'utf8' })
  assert.equal(results.dragUp, 'alpha one\nbravo', 'an upward drag selects back to where it ends')
  console.log('[terminal-focus] PASS upward drag')
  // 8. After a drag the terminal still has the keyboard.
  rmSync(file('focus-drag'), { force: true })
  await type('touch focus-drag'); await until('typing after a drag', () => existsSync(file('focus-drag')))
  console.log('[terminal-focus] PASS typing after a drag')
  // 9. The connection drops and comes back (sleep, a network change): the terminal shows new output and takes typing again.
  for (const socket of sockets) socket.destroy()
  await settle(3000)
  await input('clear; printf "after%sreconnect\\n" -\r')
  // Counted, not `waitFor`: while the tab remounts, the old and the new screen can both show it for a frame.
  const after = app.getByText('after-reconnect')
  for (let i = 0; i < 150 && !await after.count(); i++) await settle(100)
  assert.ok(await after.count(), 'output after a reconnect reaches the screen')
  shot('reconnect')
  mark = 'after-reconnect'
  await clickTyping('focus-reconnect', [4, 0], async () => { await composer() })
  console.log(JSON.stringify(results, null, 2))
} finally {
  execFileSync('pbcopy', { input: clipboard })
  for (const m of [...markers, 'notes.md']) rmSync(file(m), { force: true })
  await client.call('terminals.close', { terminal_id: terminal.id }).catch(() => {})
  await app.close()
  client.close?.()
  proxy.close()
}
process.exit(0)
