/**
 * Drive the app shell (resize handle, window frame, toasts) in a real window and
 * sample CPU while doing it. Writes screenshots; never sends a message.
 *
 *   bun scripts/shell-check.ts <out-dir> [--light]
 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { launch } from '@gpuix/react/automation'

const out = process.argv[2] ?? 'screenshots/shell'
const light = process.argv.includes('--light')
mkdirSync(out, { recursive: true })
const main = path.join(import.meta.dir, '../src/main.tsx')
const pass = ['KYBERN_DATA_DIR', 'KYBERN_URL', 'KYBERN_TOKEN', 'KYBERN_REDUCED_MOTION', 'KYBERN_OPAQUE']
const app = await launch({
  command: 'bun',
  args: [main],
  env: { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: light ? 'light' : 'dark', ...Object.fromEntries(pass.flatMap((k) => (process.env[k] ? [[k, process.env[k]!]] : []))) },
})
await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
await new Promise((r) => setTimeout(r, 2500))
const pid = Number(execFileSync('pgrep', ['-f', main], { encoding: 'utf8' }).trim().split('\n')[0])
console.log(`[shell-check] pid ${pid}`)
const shot = (name: string) => app.screenshot({ path: path.join(out, `${name}${light ? '-light' : ''}.png`) })
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** CPU% of the app over a window, from `perf/sample.ts`. */
function sample(seconds: number): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('bun', [path.join(import.meta.dir, '../perf/sample.ts'), String(seconds), `GPUIX=${pid}`], { stdio: ['ignore', 'pipe', 'inherit'] })
    let text = ''
    child.stdout.on('data', (d) => (text += d))
    child.on('close', () => resolve(text.trim().split('\n').slice(-3).join(' | ')))
  })
}

await shot('01-initial')
console.log('[shell-check] idle', await sample(10))

// Drag the sidebar wider, then to both limits.
const handle = app.getByTestId('sidebar-resize')
await handle.hover()
await wait(200)
await shot('02-handle-hover')
const before = await handle.bounds()
await handle.dragBy(140, 0, { steps: 14 })
await wait(300)
const after = await handle.bounds()
console.log(`[shell-check] seam ${before.x + 8} -> ${after.x + 8}`)
await shot('03-dragged-wider')
await handle.dragBy(900, 0, { steps: 20 })
await wait(300)
console.log(`[shell-check] max seam ${(await handle.bounds()).x + 8}`)
await handle.dragBy(-900, 0, { steps: 20 })
await wait(300)
console.log(`[shell-check] min seam ${(await handle.bounds()).x + 8}`)
await shot('04-dragged-narrow')

// CPU while dragging back and forth.
const dragging = sample(12)
const end = Date.now() + 12_000
while (Date.now() < end) {
  await handle.dragBy(120, 0, { steps: 24 })
  await handle.dragBy(-120, 0, { steps: 24 })
}
console.log('[shell-check] dragging', await dragging)
await wait(600)
console.log('[shell-check] idle after', await sample(8))
await app.close()
