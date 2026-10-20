/**
 * Artifacts tab with recorded Artifact receipts: published, publishing, failed and plain-file cards
 * (title, status line, Preview / Open in Claude / Share and versions / Check publishing options).
 * The desktop twin is the `artifact-cards` scenario of verify-dock9-desktop.mjs.
 *
 *   KYBERN_DATA_DIR=<scratch> KYBERN_CLIENT_CONFIG_DIR=<scratch> bun src/dock/verify-artifact-cards.ts [theme] [out dir]
 */
import { readFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { launch } from '@gpuix/react/automation'
import { KybernClient } from '../../../../packages/kybern-client/src/client.ts'

const data = process.env.KYBERN_DATA_DIR, clientDir = process.env.KYBERN_CLIENT_CONFIG_DIR
if (!data || !clientDir) throw new Error('Set KYBERN_DATA_DIR and KYBERN_CLIENT_CONFIG_DIR to scratch folders.')
for (const dir of [data, clientDir]) if (path.resolve(dir) === path.join(os.homedir(), '.kybern') || !path.resolve(dir).includes('gpuix-scratch')) throw new Error(`${dir} is not a scratch folder; refusing to touch the real environment.`)
const theme = process.argv[2] === 'light' ? 'light' : 'dark'
const out = process.argv[3] ?? '/Users/mymac/projects/ade/previews/gpuix/phase2/dock9/dock'
mkdirSync(out, { recursive: true })
const port = readFileSync(`${data}/daemon.port`, 'utf8').trim(), token = readFileSync(`${data}/daemon.token`, 'utf8').trim()
const client = new KybernClient({ url: `ws://127.0.0.1:${port}/ws`, token }, { createSocket: (url, key) => new WebSocket(url, { headers: { origin: 'tauri://localhost', Authorization: `Bearer ${key}` } } as unknown as string[]) })
await new Promise<void>(resolve => { client.onStatus(s => { if (s === 'open') resolve() }); client.connect() })
const project = (await client.call('projects.list', {})).projects.find(p => p.name === 'scratch-project')!
const thread = await client.call('threads.create', { project_id: project.id, title: `Artifact cards ${Date.now()}`, provider: { kind: 'claude-code', instance: 'default' }, model: 'claude-haiku-5-5' })
const app = await launch({ command: 'bun', args: [path.resolve(import.meta.dir, 'verify-artifact-cards.tsx')], env: { ...process.env, GPUIX_BACKGROUND: '1', KYBERN_OPAQUE: '1', KYBERN_APPEARANCE: theme, KYBERN_DATA_DIR: data, KYBERN_CLIENT_CONFIG_DIR: clientDir, KYBERN_GPUIX_CREDENTIALS_DIR: path.join(clientDir, 'credentials'), KYBERN_REDUCED_MOTION: process.env.KYBERN_REDUCED_MOTION ?? '1', KYBERN_WINDOW_SIZE: '1280x820' } })
const settle = (ms: number) => new Promise(r => setTimeout(r, ms))
const pid = (await app.call('initialize', { protocolVersion: 1, client: 'dock9-artifact-cards' })).pid as number
try {
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 }); await settle(1500)
  await app.getByTestId(`thread-${thread.id}`).click(); await settle(1000)
  if (!await app.getByTestId('dock-tabs').count()) await app.getByTestId('dock-toggle').click()
  await app.getByTestId('dock-add').click(); await app.getByTestId('dock-add-artifacts').click(); await settle(1500)
  const windowId = execFileSync('swift', [path.resolve(import.meta.dir, '../../visual/window-id.swift'), String(pid)], { encoding: 'utf8' }).trim()
  execFileSync('screencapture', ['-l', windowId, '-x', path.join(out, `artifact-cards-${theme}-gpuix.png`)])
} finally { await app.close(); client.close?.() }
process.exit(0)
