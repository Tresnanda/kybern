/**
 * Word and line selection from real multi-clicks (AppKit events with clickCount, see nsevent-clicks.ts) in the
 * terminal, against a scratch daemon (never ~/.kybern). xterm.js: a double-click selects the word under the pointer
 * (`wordSeparator` ' ()[]{}\',"`'), a triple-click the whole row (written trailing spaces kept); ⌘C copies it. The clipboard is saved and restored.
 *
 *   KYBERN_DATA_DIR=<scratch> KYBERN_CLIENT_CONFIG_DIR=<scratch> bun src/terminal/verify-clicks.ts [theme] [out dir]
 */
import { readFileSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs'
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
const thread = await client.call('threads.create', { project_id: project.id, title: `Terminal clicks ${Date.now()}`, provider: { kind: 'claude-code', instance: 'default' }, model: 'claude-haiku-5-5' })
const plan = path.join(data, 'click-plan.json')
const app = await launch({ command: 'bun', args: [path.resolve(import.meta.dir, 'nsevent-clicks.ts')], env: { ...process.env, GPUIX_BACKGROUND: '1', KYBERN_OPAQUE: '1', KYBERN_APPEARANCE: theme, KYBERN_DATA_DIR: data, KYBERN_CLIENT_CONFIG_DIR: client_dir, KYBERN_WINDOW_SIZE: '1280x820', CLICK_PLAN: plan } })
const settle = (ms = 700) => new Promise(r => setTimeout(r, ms))
const pid = (await app.call('initialize', { protocolVersion: 1, client: 'dock9-clicks' })).pid as number
const windowId = () => execFileSync('swift', [path.resolve(import.meta.dir, '../../visual/window-id.swift'), String(pid)], { encoding: 'utf8' }).trim()
const shot = (name: string) => execFileSync('screencapture', ['-l', windowId(), '-x', path.join(out, `${name}-${theme}-gpuix.png`)])
const CELL = 7, ROW = 21.5
const clicks = async (at: { x: number; y: number }, count: number) => {
  rmSync(plan + '.done', { force: true })
  writeFileSync(plan, JSON.stringify({ clicks: Array.from({ length: count }, (_, i) => ({ x: at.x, y: at.y, count: i + 1 })) }))
  process.kill(pid, 'SIGUSR1')
  const end = Date.now() + 5000
  while (!existsSync(plan + '.done')) { if (Date.now() > end) throw new Error('click plan did not run'); await settle(50) }
  await settle(300)
}
const clipboard = execFileSync('pbpaste', { encoding: 'buffer' })
const results: Record<string, string> = {}
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
  await input("clear; printf 'alpha (beta-gamma.delta) omega  \\n'\r"); await settle(900)
  const b = await screen.bounds()
  const y = b.y + ROW / 2 // `clear` leaves the output on row 0
  const copy = async () => { execFileSync('pbcopy', { input: 'untouched' }); await screen.press('cmd-c'); await settle(300); return execFileSync('pbpaste', { encoding: 'utf8' }) }

  await clicks({ x: b.x + 10 * CELL + 3, y }, 2) // inside "beta-gamma.delta" (columns 7–22)
  shot('double-click'); results.double = await copy()
  assert.equal(results.double, 'beta-gamma.delta', 'a double-click selects the word, xterm separators only')
  await clicks({ x: b.x + 2 * CELL + 3, y }, 2)
  results.doubleFirst = await copy()
  assert.equal(results.doubleFirst, 'alpha', 'a double-click on the first word')
  await clicks({ x: b.x + 26 * CELL + 3, y }, 3)
  shot('triple-click'); results.triple = await copy()
  assert.equal(results.triple, 'alpha (beta-gamma.delta) omega  ', 'a triple-click selects the row; printed trailing spaces stay, as in xterm')
  await clicks({ x: b.x + 4 * CELL + 3, y }, 1)
  results.singleClears = await copy()
  assert.equal(results.singleClears, 'untouched', 'a single click clears the selection')
  console.log(JSON.stringify(results, null, 2))
} finally {
  execFileSync('pbcopy', { input: clipboard })
  rmSync(plan, { force: true }); rmSync(plan + '.done', { force: true })
  for (const tab of (await client.call('terminals.list', { thread_id: thread.id })).terminals) await client.call('terminals.close', { terminal_id: tab.id }).catch(() => {})
  await app.close()
  client.close?.()
}
process.exit(0)
