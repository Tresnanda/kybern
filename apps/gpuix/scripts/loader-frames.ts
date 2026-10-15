/**
 * Capture the transcript's live "Working" loader at a few moments and crop it.
 *   KYBERN_GPUIX_THREAD=<running thread> bun scripts/loader-frames.ts <out-dir>
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { launch } from '@gpuix/react/automation'

const out = process.argv[2] ?? 'screenshots/loader'
mkdirSync(out, { recursive: true })
const app = await launch({
  command: 'bun',
  args: [path.join(import.meta.dir, '../src/main.tsx')],
  env: { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: 'dark', KYBERN_GPUIX_THREAD: process.env.KYBERN_GPUIX_THREAD ?? '' },
})
const header = await app.getByTestId('working-header').waitFor({ timeoutMs: 60_000 })
console.log(JSON.stringify((header as { bounds?: unknown }).bounds ?? header))
for (let i = 0; i < 6; i++) {
  await new Promise((r) => setTimeout(r, 230))
  await app.screenshot({ path: path.join(out, `frame-${i}.png`) })
}
await app.close()
