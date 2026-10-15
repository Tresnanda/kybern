import '../src/native/local-build.ts'
import { launch } from '@gpuix/react/automation'
import path from 'node:path'
// Same native binary, fixed 300-row list with one 10Hz loader. A/B changes only
// whether islands in virtual rows take the old inline path. One window at a time.
for (const inline of [true, false]) for (const run of [1, 2]) {
  const env: Record<string, string | undefined> = { ...process.env, GPUIX_BACKGROUND: '1', ISLAND_LAB_LIST: '1', ISLAND_LAB_CLOCK: '1', ISLAND_LAB_NO_HOVER: '1' }
  if (inline) env.KYBERN_INLINE_LIST_ISLANDS = '1'
  else delete env.KYBERN_INLINE_LIST_ISLANDS
  const app = await launch({ command: 'bun', args: [path.join(import.meta.dir, '../scripts/island-lab.tsx'), 'island'], env })
  try {
    await app.getByTestId('app-ready').waitFor()
    const { pid } = await app.call('initialize', { protocolVersion: 1, client: 'list-perf' })
    const sample = async (seconds: number, label: string, quiet = false) => {
      const child = Bun.spawn(['bun', path.join(import.meta.dir, '../perf/sample.ts'), String(seconds), `${label}=${pid}`], { stdout: quiet ? 'ignore' : 'inherit', stderr: 'inherit' })
      if (await child.exited) throw Error('Sampler failed')
    }
    await sample(10, 'warmup', true)
    await sample(15, `${inline ? 'Inline' : 'Cached'} virtual rows ${run}`)
  } finally { await app.close() }
}
