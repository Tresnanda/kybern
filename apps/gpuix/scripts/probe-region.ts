/**
 * Bisect frame cost: launch with the perf probe, optionally click testIds first.
 *   bun scripts/probe-region.ts <out.txt> [testId ...]
 */
import path from 'node:path'
import { launch } from '@gpuix/react/automation'
const [out, ...clicks] = process.argv.slice(2)
const app = await launch({
  command: 'bun',
  args: [path.join(import.meta.dir, '../src/main.tsx')],
  env: { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: 'dark', KYBERN_PERF_PROBE: '1', KYBERN_PERF_PROBE_STAY: '1', KYBERN_PERF_PROBE_DELAY: '9000', KYBERN_PERF_PROBE_OUT: out!, ...(process.env.KYBERN_GPUIX_THREAD ? { KYBERN_GPUIX_THREAD: process.env.KYBERN_GPUIX_THREAD } : {}) },
})
await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
await new Promise((r) => setTimeout(r, 3000))
for (const id of clicks) await app.getByTestId(id).click()
await new Promise((r) => setTimeout(r, 12_000))
await app.close()
