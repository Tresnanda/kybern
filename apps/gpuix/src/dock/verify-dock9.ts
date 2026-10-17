/**
 * Real-app check of the Phase 2 dock9 surfaces against a scratch daemon (never ~/.kybern):
 * Preview (file page, ⌥⌘P mini player and its hover header), Artifacts (HTML and Markdown
 * dialogs), the Environment panel. Embedded web views are NSViews, so images are OS window
 * captures (`screencapture -l`), not GPUI screenshots.
 *
 *   KYBERN_DATA_DIR=<scratch> KYBERN_CLIENT_CONFIG_DIR=<scratch> bun src/dock/verify-dock9.ts [theme] [out dir] [scenario ...]
 */
import { readFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { launch } from '@gpuix/react/automation'
import { KybernClient } from '../../../../packages/kybern-client/src/client.ts'

const data = process.env.KYBERN_DATA_DIR, clientDir = process.env.KYBERN_CLIENT_CONFIG_DIR
if (!data || !clientDir) throw new Error('Set KYBERN_DATA_DIR and KYBERN_CLIENT_CONFIG_DIR to scratch folders.')
for (const dir of [data, clientDir]) if (path.resolve(dir) === path.join(os.homedir(), '.kybern') || !path.resolve(dir).includes('gpuix-scratch')) throw new Error(`${dir} is not a scratch folder; refusing to touch the real environment.`)
const theme = process.argv[2] === 'light' ? 'light' : 'dark'
const out = process.argv[3] ?? '/Users/mymac/projects/ade/previews/gpuix/phase2/dock9/dock'
const wanted = process.argv.slice(4)
mkdirSync(out, { recursive: true })
const port = readFileSync(`${data}/daemon.port`, 'utf8').trim(), token = readFileSync(`${data}/daemon.token`, 'utf8').trim()
const client = new KybernClient({ url: `ws://127.0.0.1:${port}/ws`, token }, { createSocket: (url, key) => new WebSocket(url, { headers: { origin: 'tauri://localhost', Authorization: `Bearer ${key}` } } as unknown as string[]) })
await new Promise<void>(resolve => { client.onStatus(s => { if (s === 'open') resolve() }); client.connect() })
const project = (await client.call('projects.list', {})).projects.find(p => p.name === 'scratch-project')!
const thread = await client.call('threads.create', { project_id: project.id, title: `Dock9 check ${Date.now()}`, provider: { kind: 'claude-code', instance: 'default' }, model: 'claude-haiku-5-5' })
const app = await launch({ command: 'bun', args: [path.resolve(import.meta.dir, '../main.tsx')], env: { ...process.env, GPUIX_BACKGROUND: '1', KYBERN_OPAQUE: '1', KYBERN_APPEARANCE: theme, KYBERN_DATA_DIR: data, KYBERN_CLIENT_CONFIG_DIR: clientDir, KYBERN_GPUIX_CREDENTIALS_DIR: path.join(clientDir, 'credentials'), KYBERN_REDUCED_MOTION: process.env.KYBERN_REDUCED_MOTION ?? '1', KYBERN_WINDOW_SIZE: process.env.KYBERN_WINDOW_SIZE ?? '1280x820' } })
const settle = (ms = 700) => new Promise(r => setTimeout(r, ms))
const pid = (await app.call('initialize', { protocolVersion: 1, client: 'dock9-verify' })).pid as number
const windowId = () => execFileSync('swift', [path.resolve(import.meta.dir, '../../visual/window-id.swift'), String(pid)], { encoding: 'utf8' }).trim()
const shot = (name: string) => execFileSync('screencapture', ['-l', windowId(), '-x', path.join(out, `${name}-${theme}-gpuix.png`)])
const ran = (name: string) => !wanted.length || wanted.includes(name)
try {
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 }); await settle(1500)
  await app.getByTestId(`thread-${thread.id}`).click(); await settle(1000)
  if (!await app.getByTestId('dock-tabs').count()) await app.getByTestId('dock-toggle').click()
  await settle(500)
  const openTab = async (tab: string) => { await app.getByTestId('dock-add').click(); await app.getByTestId(`dock-add-${tab}`).click(); await settle(900) }
  if (ran('preview')) {
    console.log('scenario preview')
    await openTab('preview')
    const address = app.getByTestId('preview-address')
    await address.fill(`${project.path}/preview.html`); await address.press('enter')
    await app.getByTestId('preview-slot-dock').waitFor({ timeoutMs: 20_000 }); await settle(1800)
    shot('preview-file')
    // ⌥⌘P floats the page; ⌥⌘P again docks it.
    await app.getByTestId('app-ready').press('cmd-alt-p'); await app.getByTestId('preview-mini').waitFor({ timeoutMs: 10_000 }); await settle(900)
    shot('preview-mini')
    const b = await app.getByTestId('preview-mini').bounds()
    await app.mouse.move({ x: b.x + b.width / 2, y: b.y + 14 }); await settle(500)
    shot('preview-mini-hover')
    await app.mouse.move({ x: 20, y: 20 }); await app.getByTestId('app-ready').press('cmd-alt-p'); await app.getByTestId('preview-slot-dock').waitFor({ timeoutMs: 10_000 }); await settle(800)
    shot('preview-docked-again')
  }
  if (ran('artifacts')) {
    console.log('scenario artifacts')
    await openTab('artifacts')
    shot('artifacts')
    await app.getByTestId('artifact-path').fill('artifacts/dashboard.html'); await app.getByTestId('artifact-preview').click()
    await app.getByTestId('artifact-frame').waitFor({ timeoutMs: 20_000 }); await settle(1800)
    shot('artifact-html')
    await app.getByTestId('artifact-source').click(); await settle(900); shot('artifact-source')
    await app.getByTestId('dialog-close').click(); await settle(500)
    await app.getByTestId('artifact-path').fill('artifacts/notes.md'); await app.getByTestId('artifact-preview').click(); await settle(1500); shot('artifact-markdown')
    await app.getByTestId('dialog-close').click(); await settle(500)
  }
  if (ran('environment')) {
    console.log('scenario environment')
    await app.getByTestId('environment-toggle').click(); await app.getByTestId('environment-panel').waitFor({ timeoutMs: 10_000 }); await settle(900)
    shot('environment')
    await app.getByTestId('environment-sections').click(); await settle(500); shot('environment-sections')
  }
} finally {
  await app.close()
  client.close?.()
}
assert.ok(true)
process.exit(0)
