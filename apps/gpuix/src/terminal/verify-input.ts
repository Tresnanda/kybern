/**
 * Real-input terminal check against a scratch daemon (never ~/.kybern): mouse reporting
 * (SGR 1000/1006) from a real click, bracketed paste from ⌘V, selection + ⌘C, and the pty
 * following a dock resize. The shell writes what it received to files in the scratch
 * project, so every assertion is on bytes the program really read.
 *
 * The system clipboard is saved and restored around the copy/paste steps (synthetic
 * input cannot reach the pasteboard otherwise); nothing else outside this window is touched.
 *
 *   KYBERN_DATA_DIR=<scratch> KYBERN_CLIENT_CONFIG_DIR=<scratch> bun src/terminal/verify-input.ts [theme] [out dir]
 */
import { readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { launch } from '@gpuix/react/automation'
import { KybernClient } from '../../../../packages/kybern-client/src/client.ts'

const data = process.env.KYBERN_DATA_DIR, client_dir = process.env.KYBERN_CLIENT_CONFIG_DIR
if (!data || !client_dir) throw new Error('Set KYBERN_DATA_DIR and KYBERN_CLIENT_CONFIG_DIR to scratch folders.')
for (const dir of [data, client_dir]) if (path.resolve(dir) === path.join(os.homedir(), '.kybern') || !path.resolve(dir).includes('gpuix-scratch')) throw new Error(`${dir} is not a scratch folder; refusing to touch the real environment.`)
const theme = process.argv[2] === 'light' ? 'light' : 'dark'
const out = process.argv[3] ?? '/Users/mymac/projects/ade/previews/gpuix/phase2/dock9/terminal'
mkdirSync(out, { recursive: true })
const port = readFileSync(`${data}/daemon.port`, 'utf8').trim(), token = readFileSync(`${data}/daemon.token`, 'utf8').trim()
const client = new KybernClient({ url: `ws://127.0.0.1:${port}/ws`, token }, { createSocket: (url, key) => new WebSocket(url, { headers: { origin: 'tauri://localhost', Authorization: `Bearer ${key}` } } as unknown as string[]) })
const ready = new Promise<void>(resolve => client.onStatus(s => { if (s === 'open') resolve() })); client.connect(); await ready
const project = (await client.call('projects.list', {})).projects.find(p => p.name === 'scratch-project')!
const thread = await client.call('threads.create', { project_id: project.id, title: `Terminal input ${Date.now()}`, provider: { kind: 'claude-code', instance: 'default' }, model: 'claude-haiku-5-5' })
const app = await launch({ command: 'bun', args: [path.resolve(import.meta.dir, '../main.tsx')], env: { ...process.env, GPUIX_BACKGROUND: '1', KYBERN_OPAQUE: '1', KYBERN_APPEARANCE: theme, KYBERN_DATA_DIR: data, KYBERN_CLIENT_CONFIG_DIR: client_dir, KYBERN_GPUIX_CREDENTIALS_DIR: path.join(client_dir, 'credentials'), KYBERN_REDUCED_MOTION: process.env.KYBERN_REDUCED_MOTION ?? '1', KYBERN_WINDOW_SIZE: process.env.KYBERN_WINDOW_SIZE ?? '1280x820' } })
const settle = (ms = 700) => new Promise(r => setTimeout(r, ms))
const until = async (what: string, ok: () => boolean, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (ok()) return; await settle(100) } throw new Error(`timed out waiting for ${what}`) }
const pid = (await app.call('initialize', { protocolVersion: 1, client: 'dock9-input' })).pid as number
const windowId = () => execFileSync('swift', [path.resolve(import.meta.dir, '../../visual/window-id.swift'), String(pid)], { encoding: 'utf8' }).trim()
const shot = (name: string) => execFileSync('screencapture', ['-l', windowId(), '-x', path.join(out, `${name}-${theme}-gpuix.png`)])
const CELL = 7, ROW = 21.5
const file = (name: string) => path.join(project.path, name)
const read = (name: string) => existsSync(file(name)) ? readFileSync(file(name), 'utf8').trim() : ''
const clipboard = execFileSync('pbpaste', { encoding: 'buffer' })
const results: Record<string, unknown> = {}
try {
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 }); await settle(1500)
  await app.getByTestId(`thread-${thread.id}`).click(); await settle(1000)
  if (!await app.getByTestId('dock-tabs').count()) await app.getByTestId('dock-toggle').click()
  await settle(500)
  await app.getByTestId('dock-add').click(); await app.getByTestId('dock-add-terminal').click()
  const screen = app.getByTestId('terminal-screen')
  await screen.waitFor({ timeoutMs: 30_000 }); await settle(1500)
  const terminal = () => client.call('terminals.list', { thread_id: thread.id }).then(r => r.terminals.find(t => t.alive)!)
  const input = async (text: string) => { await client.call('terminals.input', { terminal_id: (await terminal()).id, data: Buffer.from(text).toString('base64') }) }
  for (const f of ['in-mouse.hex', 'in-mouse.ready', 'in-paste.hex', 'in-paste.ready', 'in-size-1', 'in-size-2']) rmSync(file(f), { force: true })
  await input(`cd ${project.path}\r`); await settle(600)
  await screen.click(); await settle(300)

  // 1. Mouse reporting: a real click on a program that enabled 1000 + 1006 arrives as an SGR press and release.
  rmSync(file('in-mouse.ready'), { force: true })
  await input(`clear; printf '\\033[?1000h\\033[?1006h'; stty raw -echo min 0 time 20; : > in-mouse.ready; cat | xxd -p > in-mouse.hex; stty sane; printf '\\033[?1000l\\033[?1006l'\r`); await until('mouse program ready', () => existsSync(file('in-mouse.ready'))); await settle(200)
  const b = await screen.bounds()
  const at = { x: b.x + 10 * CELL + 3, y: b.y + 4 * ROW + 5 } // `bounds()` is the content box, inside the padding
  await app.mouse.down(at); await settle(80); await app.mouse.up(at)
  await until('mouse bytes', () => read('in-mouse.hex').length > 0, 15000)
  const mouse = Buffer.from(read('in-mouse.hex').replace(/\s/g, ''), 'hex').toString('latin1')
  results.mouse = JSON.stringify(mouse)
  assert.match(mouse, /^\x1b\[<0;11;5M\x1b\[<0;11;5m$/, `SGR press then release on row 5, got ${JSON.stringify(mouse)}`)
  await settle(500)

  // 2. Bracketed paste: ⌘V of a two-line clipboard arrives wrapped in 200~/201~ with a carriage return.
  execFileSync('pbcopy', { input: 'one\ntwo' }); rmSync(file('in-paste.ready'), { force: true })
  await input(`clear; printf '\\033[?2004h'; stty raw -echo; : > in-paste.ready; head -c 19 | xxd -p > in-paste.hex; stty sane; printf '\\033[?2004l'\r`); await until('paste program ready', () => existsSync(file('in-paste.ready'))); await settle(200)
  await screen.click(); await settle(200)
  await screen.press('cmd-v')
  await until('paste bytes', () => read('in-paste.hex').length > 0)
  const paste = Buffer.from(read('in-paste.hex').replace(/\s/g, ''), 'hex').toString('latin1')
  results.paste = JSON.stringify(paste)
  assert.equal(paste, '\x1b[200~one\rtwo\x1b[201~', 'bracketed paste with CR')
  await settle(500)

  // 3. Selection + copy: a drag over the word selects exactly those cells and ⌘C puts them on the pasteboard;
  //    a double-click selects the word (recorded, then cleared by the next drag).
  await input('clear; echo SELECTME\r'); await settle(800)
  execFileSync('pbcopy', { input: 'untouched' })
  const y = b.y + ROW / 2 // `clear` wipes the command line, so the output is on row 0
  const word = { x: b.x + 3 * CELL, y }
  for (let n = 0; n < 2; n++) { await app.mouse.down(word); await app.mouse.up(word) } // two quick presses at one point
  await screen.press('cmd-c'); await settle(300)
  results.doubleClickCopied = execFileSync('pbpaste', { encoding: 'utf8' })
  execFileSync('pbcopy', { input: 'untouched' })
  await app.mouse.drag({ x: b.x + 1, y }, { x: b.x + 8 * CELL + 1, y }); await settle(300); shot('selection')
  await screen.press('cmd-c'); await settle(300)
  const copied = execFileSync('pbpaste', { encoding: 'utf8' })
  results.copied = copied
  assert.equal(copied, 'SELECTME', 'a drag selects the cells and ⌘C copies them')

  // 4. Resize: the pty size follows the dock width.
  await input('clear; stty size > in-size-1\r'); await settle(800)
  const handle = app.getByTestId('dock-resize')
  await handle.dragBy(-140, 0); await settle(1200)
  await input('clear; stty size > in-size-2\r'); await settle(800)
  const [s1, s2] = [read('in-size-1'), read('in-size-2')]
  results.size = { before: s1, after: s2 }
  assert.notEqual(s1, s2, 'the pty size changed with the dock')
  await handle.dragBy(140, 0); await settle(800)

  // 5. Wide glyphs, emoji and combining marks line up with the cell grid.
  await input(`clear; printf '漢字かな ★ 🙂🙂 e\\xcc\\x81 |end|\\n12345678901234567890\\n'\r`); await settle(900); shot('wide')
  console.log(JSON.stringify(results, null, 2))
} finally {
  execFileSync('pbcopy', { input: clipboard })
  for (const f of ['in-mouse.hex', 'in-mouse.ready', 'in-paste.hex', 'in-paste.ready', 'in-size-1', 'in-size-2']) rmSync(file(f), { force: true })
  for (const tab of (await client.call('terminals.list', { thread_id: thread.id })).terminals) await client.call('terminals.close', { terminal_id: tab.id }).catch(() => {})
  await app.close()
  client.close?.()
}
process.exit(0)
