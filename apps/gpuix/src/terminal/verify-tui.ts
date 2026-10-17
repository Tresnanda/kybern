/**
 * Real-app terminal check against a scratch daemon (never ~/.kybern):
 *
 *   KYBERN_DATA_DIR=<scratch dir> KYBERN_CLIENT_CONFIG_DIR=<scratch dir> bun src/terminal/verify-tui.ts [theme] [out dir] [scenario ...]
 *
 * Runs commands in a terminal tab (typed through the terminal's own input RPC, and a few
 * with real key presses) and screenshots each state. The desktop twin is `verify-tui-desktop.mjs`.
 */
import { readFileSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { launch } from '@gpuix/react/automation'
import { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
import { DATA, type Step } from './verify-scenarios.ts'

const data = process.env.KYBERN_DATA_DIR, client_dir = process.env.KYBERN_CLIENT_CONFIG_DIR
if (!data || !client_dir) throw new Error('Set KYBERN_DATA_DIR and KYBERN_CLIENT_CONFIG_DIR to scratch folders.')
for (const dir of [data, client_dir]) if (path.resolve(dir) === path.join(os.homedir(), '.kybern') || !path.resolve(dir).includes('gpuix-scratch')) throw new Error(`${dir} is not a scratch folder; refusing to touch the real environment.`)
const theme = process.argv[2] === 'light' ? 'light' : 'dark'
const out = process.argv[3] ?? '/Users/mymac/projects/ade/previews/gpuix/phase2/dock9/terminal'
const wanted = process.argv.slice(4)
mkdirSync(out, { recursive: true })
const port = readFileSync(`${data}/daemon.port`, 'utf8').trim(), token = readFileSync(`${data}/daemon.token`, 'utf8').trim()
const client = new KybernClient({ url: `ws://127.0.0.1:${port}/ws`, token }, { createSocket: (url, key) => new WebSocket(url, { headers: { origin: 'tauri://localhost', Authorization: `Bearer ${key}` } } as unknown as string[]) })
const ready = new Promise<void>(resolve => client.onStatus(s => { if (s === 'open') resolve() })); client.connect(); await ready
const project = (await client.call('projects.list', {})).projects.find(p => p.name === 'scratch-project')!
assert.ok(project, 'scratch-project exists')
const thread = await client.call('threads.create', { project_id: project.id, title: `Terminal check ${Date.now()}`, provider: { kind: 'claude-code', instance: 'default' }, model: 'claude-haiku-5-5' })
const app = await launch({ command: 'bun', args: [path.resolve(import.meta.dir, '../main.tsx')], env: { ...process.env, GPUIX_BACKGROUND: '1', KYBERN_OPAQUE: '1', KYBERN_APPEARANCE: theme, KYBERN_DATA_DIR: data, KYBERN_CLIENT_CONFIG_DIR: client_dir, KYBERN_GPUIX_CREDENTIALS_DIR: path.join(client_dir, 'credentials'), KYBERN_REDUCED_MOTION: process.env.KYBERN_REDUCED_MOTION ?? '1', KYBERN_WINDOW_SIZE: process.env.KYBERN_WINDOW_SIZE ?? '1280x820' } })
const settle = (ms = 700) => new Promise(r => setTimeout(r, ms))
try {
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 }); await settle(1500)
  await app.getByTestId(`thread-${thread.id}`).click(); await settle(1000)
  if (!await app.getByTestId('dock-tabs').count()) await app.getByTestId('dock-toggle').click()
  await settle(500)
  await app.getByTestId('dock-add').click(); await app.getByTestId('dock-add-terminal').click()
  await app.getByTestId('terminal-screen').waitFor({ timeoutMs: 30_000 }); await settle(1500)
  const terminal = () => client.call('terminals.list', { thread_id: thread.id }).then(r => r.terminals.find(t => t.alive)!)
  const input = async (text: string) => { await client.call('terminals.input', { terminal_id: (await terminal()).id, data: Buffer.from(text).toString('base64') }) }
  await input(`cd ${project.path}\r`); await settle(800)
  const run = async (steps: Step[]) => { for (const step of steps) { if (typeof step === 'string') await input(step); else await settle(step.wait) } }
  for (const scenario of DATA) {
    if (wanted.length && !wanted.includes(scenario.name)) continue
    console.log('scenario', scenario.name)
    await run(scenario.steps)
    await settle(300); await app.screenshot({ path: path.join(out, `${scenario.name}-${theme}-gpuix.png`) })
    for (const more of scenario.then ?? []) { await run(more.steps); await settle(300); await app.screenshot({ path: path.join(out, `${scenario.name}${more.label}-${theme}-gpuix.png`) }) }
  }
  if (!wanted.length || wanted.includes('keys')) {
    // Real key presses through the native window: focus, typing, Ctrl-C, arrows and Return reach the shell.
    console.log('scenario keys')
    await input('clear\r'); await settle(500)
    const screen = app.getByTestId('terminal-screen')
    await screen.click(); await settle(300)
    await app.screenshot({ path: path.join(out, `focus-${theme}-gpuix.png`) })
    for (const key of 'touch gpuixok'.split('')) await screen.press(key === ' ' ? 'space' : key)
    await screen.press('enter'); await settle(800)
    const made = await Bun.file(path.join(project.path, 'gpuixok')).exists()
    console.log('typed touch created the file:', made)
    assert.ok(made, 'typing reached the shell')
  }
} finally {
  for (const tab of (await client.call('terminals.list', { thread_id: thread.id })).terminals) await client.call('terminals.close', { terminal_id: tab.id }).catch(() => {})
  await app.close()
  client.close?.()
}
process.exit(0)
