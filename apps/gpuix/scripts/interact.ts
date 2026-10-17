/**
 * Drive the live app: collapse the thread panel (capturing motion frames), move
 * the rail pill, and type into the composer. Never sends a message.
 *
 *   bun scripts/interact.ts <out-dir>
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { launch } from '@gpuix/react/automation'

/** App settings passed through from this shell (data dir, thread, motion). */
function forwarded(): Record<string, string> {
  const keys = ['KYBERN_DATA_DIR', 'KYBERN_URL', 'KYBERN_TOKEN', 'KYBERN_GPUIX_THREAD', 'KYBERN_REDUCED_MOTION', 'KYBERN_OPAQUE']
  return Object.fromEntries(keys.flatMap((k) => (process.env[k] ? [[k, process.env[k]!]] : [])))
}

const out = process.argv[2] ?? 'screenshots/interact'
mkdirSync(out, { recursive: true })
const app = await launch({
  command: 'bun',
  args: [path.join(import.meta.dir, '../src/main.tsx')],
  env: { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: 'dark', ...forwarded() },
})
await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
await new Promise((r) => setTimeout(r, 2500))

let at = await app.clock.pause()
await app.getByTestId('sidebar-toggle').click()
await app.captureFrames(path.join(out, 'collapse'), [at, at + 40, at + 80, at + 140, at + 240])
await app.clock.resume()

at = await app.clock.pause()
await app.getByTestId('rail-tasks').click()
await app.captureFrames(path.join(out, 'rail'), [at, at + 50, at + 110, at + 240])
await app.clock.resume()

await app.getByTestId('rail-home').click()
await app.getByTestId('sidebar-toggle').click()
await new Promise((r) => setTimeout(r, 400))
await app.getByTestId('composer').fill('Draft text typed by automation')
await new Promise((r) => setTimeout(r, 300))
await app.screenshot({ path: path.join(out, 'typed.png') })
await app.close()
console.log('[interact] done')
