/**
 * Frame intervals for the dock9 surfaces' motion (scene submissions from KYBERN_FRAME_TIMES, as in
 * src/platform/verify.motion.ts): ⌥⌘P float and dock of the preview, the mini player's hover
 * header, the Environment card open/close, then idle with a terminal, with the preview docked.
 * The harness writes `[mark]` lines into the trace before each step, so a step's frames are the
 * first contiguous burst (gaps < 100 ms) after its mark. No screenshots or manual clocks.
 *
 *   KYBERN_DATA_DIR=<scratch> KYBERN_CLIENT_CONFIG_DIR=<scratch> bun src/dock/verify-motion.ts <out.json> [reduced]
 */
import { spawn } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { connectStdio } from '@gpuix/react/automation'
import { KybernClient } from '../../../../packages/kybern-client/src/client.ts'

const data = process.env.KYBERN_DATA_DIR, clientDir = process.env.KYBERN_CLIENT_CONFIG_DIR
if (!data || !clientDir) throw new Error('Set KYBERN_DATA_DIR and KYBERN_CLIENT_CONFIG_DIR to scratch folders.')
for (const dir of [data, clientDir]) if (path.resolve(dir) === path.join(os.homedir(), '.kybern') || !path.resolve(dir).includes('gpuix-scratch')) throw new Error(`${dir} is not a scratch folder; refusing to touch the real environment.`)
const [out = '/tmp/dock9-motion.json', motion] = process.argv.slice(2)
const trace = `${out}.trace`
writeFileSync(trace, '')
const port = readFileSync(`${data}/daemon.port`, 'utf8').trim(), token = readFileSync(`${data}/daemon.token`, 'utf8').trim()
const client = new KybernClient({ url: `ws://127.0.0.1:${port}/ws`, token }, { createSocket: (url, key) => new WebSocket(url, { headers: { origin: 'tauri://localhost', Authorization: `Bearer ${key}` } } as unknown as string[]) })
await new Promise<void>(resolve => { client.onStatus(s => { if (s === 'open') resolve() }); client.connect() })
const project = (await client.call('projects.list', {})).projects.find(p => p.name === 'scratch-project')!
const thread = await client.call('threads.create', { project_id: project.id, title: `Dock9 motion ${Date.now()}`, provider: { kind: 'claude-code', instance: 'default' }, model: 'claude-haiku-5-5' })
const child = spawn('bun', [path.resolve(import.meta.dir, '../main.tsx')], { stdio: ['pipe', 'pipe', 'pipe'], env: {
  ...process.env, GPUIX_BACKGROUND: '1', KYBERN_OPAQUE: '1', KYBERN_APPEARANCE: process.env.KYBERN_APPEARANCE ?? 'dark', KYBERN_FRAME_TIMES: '1', KYBERN_DATA_DIR: data, KYBERN_CLIENT_CONFIG_DIR: clientDir,
  KYBERN_GPUIX_CREDENTIALS_DIR: path.join(clientDir, 'credentials'), KYBERN_REDUCED_MOTION: motion === 'reduced' ? '1' : '0', KYBERN_WINDOW_SIZE: '1280x820',
} })
child.stderr.on('data', chunk => appendFileSync(trace, chunk))
const watchdog = setTimeout(() => child.kill(), 150_000)
const app = await connectStdio({ write: chunk => { child.stdin.write(chunk) }, feed: listener => child.stdout.on('data', chunk => listener(String(chunk))), close: async () => { child.kill() } })
const mark = (label: string) => appendFileSync(trace, `[mark] ${label}\n`)
const settle = (ms: number) => Bun.sleep(ms)

function framesAfter(label: string) {
  const lines = readFileSync(trace, 'utf8').split('\n')
  const start = lines.indexOf(`[mark] ${label}`)
  const times: number[] = []
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('[mark]')) break
    const m = /\[kybern-frame\] ([\d.]+)/.exec(line)
    if (m) times.push(Number(m[1]))
  }
  return times
}
function burst(times: number[]) {
  const first: number[] = []
  for (const t of times) { if (first.length && t - first.at(-1)! >= 100) break; first.push(t) }
  const deltas = first.slice(1).map((t, i) => t - first[i]!).sort((a, b) => a - b)
  return { frames: first.length, spanMs: first.length ? Math.round(first.at(-1)! - first[0]!) : 0, p50: deltas[Math.floor(deltas.length * 0.5)] ?? null, p95: deltas[Math.floor(deltas.length * 0.95)] ?? null, max: deltas.at(-1) ?? null }
}

const result: Record<string, unknown> = { fullRate: process.env.KYBERN_FULL_RATE ?? 'unset', reducedMotion: motion === 'reduced', kind: 'scene submissions, not compositor presentations; first contiguous burst after each step' }
try {
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 }); await settle(1500)
  await app.getByTestId(`thread-${thread.id}`).click(); await settle(1000)
  if (!await app.getByTestId('dock-tabs').count()) await app.getByTestId('dock-toggle').click()
  await settle(600)
  await app.getByTestId('dock-add').click(); await app.getByTestId('dock-add-preview').click(); await settle(900)
  const address = app.getByTestId('preview-address')
  await address.fill(`${project.path}/preview.html`); await address.press('enter')
  await app.getByTestId('preview-slot-dock').waitFor({ timeoutMs: 20_000 }); await settle(2000)
  mark('float')
  await app.getByTestId('app-ready').press('cmd-alt-p'); await app.getByTestId('preview-mini').waitFor({ timeoutMs: 10_000 }); await settle(1500)
  const b = await app.getByTestId('preview-mini').bounds()
  mark('body-hover')
  await app.mouse.move({ x: b.x + b.width / 2, y: b.y + b.height / 2 }); await settle(1000)
  await app.mouse.move({ x: 20, y: 20 }); await settle(700)
  const spots: Record<string, [number, number]> = { 'cx-y14': [b.width / 2, 14], 'cx-y40': [b.width / 2, 40], 'left-y14': [20, 14], 'right-y14': [b.width - 30, 14], 'cx-y26': [b.width / 2, 26] }
  const spotFrames: Record<string, number> = {}
  for (const [name, [dx, dy]] of Object.entries(spots)) {
    mark(`spot-${name}`)
    await app.mouse.move({ x: b.x + dx, y: b.y + dy }); await settle(1000)
    await app.mouse.move({ x: 20, y: 20 }); await settle(600)
    spotFrames[name] = framesAfter(`spot-${name}`).filter((t, _, f) => t >= f[0]! + 400 && t < f[0]! + 1000).length
  }
  result.spotFramesBetween400And1000ms = spotFrames
  mark('hover')
  await app.mouse.move({ x: b.x + b.width / 2, y: b.y + 14 }); await settle(500)
  if (process.env.DOCK9_SAMPLE) Bun.spawnSync(['/usr/bin/sample', String(child.pid), '1', '1', '-file', process.env.DOCK9_SAMPLE])
  await settle(700)
  mark('unhover')
  await app.mouse.move({ x: 20, y: 20 }); await settle(1200)
  mark('dock')
  await app.getByTestId('app-ready').press('cmd-alt-p'); await app.getByTestId('preview-slot-dock').waitFor({ timeoutMs: 10_000 }); await settle(1500)
  const slot = await app.getByTestId('preview-slot-dock').bounds()
  mark('docked-hover')
  await app.mouse.move({ x: slot.x + slot.width / 2, y: slot.y + slot.height / 2 }); await settle(1200)
  await app.mouse.move({ x: 20, y: 20 }); await settle(500)
  mark('environment-open')
  await app.getByTestId('environment-toggle').click(); await app.getByTestId('environment-panel').waitFor({ timeoutMs: 10_000 }); await settle(1200)
  mark('environment-close')
  await app.getByTestId('environment-toggle').click(); await settle(1200)
  mark('idle')
  await settle(4000)
  mark('end')
  for (const [key, label] of [['mini float', 'float'], ['mini hover header in', 'hover'], ['mini hover header out', 'unhover'], ['mini dock', 'dock'], ['environment open', 'environment-open'], ['environment close', 'environment-close']] as const) result[key] = burst(framesAfter(label))
  result.dockedHoverFramesPer200ms = Array.from({ length: 6 }, (_, i) => { const f = framesAfter('docked-hover'); return f.filter(t => t >= f[0]! + i * 200 && t < f[0]! + (i + 1) * 200).length }); result.bodyHoverFramesPer200ms = Array.from({ length: 5 }, (_, i) => { const f = framesAfter('body-hover'); return f.filter(t => t >= f[0]! + i * 200 && t < f[0]! + (i + 1) * 200).length }); result.idleFrames4s = framesAfter('idle').length
  const hoverFrames = framesAfter('hover')
  result.hoverFramesPer200ms = hoverFrames.length ? Array.from({ length: 6 }, (_, i) => hoverFrames.filter(t => t >= hoverFrames[0]! + i * 200 && t < hoverFrames[0]! + (i + 1) * 200).length) : []
  writeFileSync(out, JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 1))
} finally { clearTimeout(watchdog); await app.close(); if (child.exitCode === null) child.kill(); client.close?.() }
process.exit(0)
