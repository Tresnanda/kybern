/**
 * Idle cost of the terminal tab: 10 s warm-up, then `perf/sample.ts` for 15 s with a shell prompt, focused
 * (cursor blink on) and then unfocused. KYBERN_FULL_RATE is reported with the numbers.
 *
 *   KYBERN_DATA_DIR=<scratch> KYBERN_CLIENT_CONFIG_DIR=<scratch> bun src/terminal/verify-resources.ts [theme]
 */
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launch } from '@gpuix/react/automation'
import { KybernClient } from '../../../../packages/kybern-client/src/client.ts'

const data = process.env.KYBERN_DATA_DIR, clientDir = process.env.KYBERN_CLIENT_CONFIG_DIR
if (!data || !clientDir) throw new Error('Set KYBERN_DATA_DIR and KYBERN_CLIENT_CONFIG_DIR to scratch folders.')
for (const dir of [data, clientDir]) if (path.resolve(dir) === path.join(os.homedir(), '.kybern') || !path.resolve(dir).includes('gpuix-scratch')) throw new Error(`${dir} is not a scratch folder; refusing to touch the real environment.`)
const theme = process.argv[2] === 'light' ? 'light' : 'dark'
const port = readFileSync(`${data}/daemon.port`, 'utf8').trim(), token = readFileSync(`${data}/daemon.token`, 'utf8').trim()
const client = new KybernClient({ url: `ws://127.0.0.1:${port}/ws`, token }, { createSocket: (url, key) => new WebSocket(url, { headers: { origin: 'tauri://localhost', Authorization: `Bearer ${key}` } } as unknown as string[]) })
await new Promise<void>(resolve => { client.onStatus(s => { if (s === 'open') resolve() }); client.connect() })
const project = (await client.call('projects.list', {})).projects.find(p => p.name === 'scratch-project')!
const thread = await client.call('threads.create', { project_id: project.id, title: `Terminal resources ${Date.now()}`, provider: { kind: 'claude-code', instance: 'default' }, model: 'claude-haiku-5-5' })
const app = await launch({ command: 'bun', args: [path.resolve(import.meta.dir, '../main.tsx')], env: { ...process.env, GPUIX_BACKGROUND: '1', KYBERN_OPAQUE: '1', KYBERN_APPEARANCE: theme, KYBERN_DATA_DIR: data, KYBERN_CLIENT_CONFIG_DIR: clientDir, KYBERN_GPUIX_CREDENTIALS_DIR: path.join(clientDir, 'credentials'), KYBERN_REDUCED_MOTION: '0', KYBERN_WINDOW_SIZE: '1280x820' } })
const settle = (ms: number) => new Promise(r => setTimeout(r, ms))
const pid = (await app.call('initialize', { protocolVersion: 1, client: 'dock9-resources' })).pid as number
const sample = () => Bun.spawnSync(['bun', path.resolve(import.meta.dir, '../../perf/sample.ts'), '15', `GPUIX=${pid}`], { stdout: 'pipe' }).stdout.toString().trim()
try {
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 }); await settle(1500)
  await app.getByTestId(`thread-${thread.id}`).click(); await settle(1000)
  if (!await app.getByTestId('dock-tabs').count()) await app.getByTestId('dock-toggle').click()
  await app.getByTestId('dock-add').click(); await app.getByTestId('dock-add-terminal').click()
  const screen = app.getByTestId('terminal-screen'); await screen.waitFor({ timeoutMs: 30_000 }); await settle(1500)
  await screen.click(); await settle(10_000)
  console.log(`KYBERN_FULL_RATE=${process.env.KYBERN_FULL_RATE ?? 'unset'} reduced-motion=off\nfocused terminal (cursor blinking):\n${sample()}`)
  await app.getByTestId('composer-input').click().catch(() => {}); await settle(10_000)
  console.log(`unfocused terminal:\n${sample()}`)
  for (const tab of (await client.call('terminals.list', { thread_id: thread.id })).terminals) await client.call('terminals.close', { terminal_id: tab.id }).catch(() => {})
} finally { await app.close(); client.close?.() }
process.exit(0)
