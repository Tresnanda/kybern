/** Same no-checkpoint environment panel, two 10s warmups + 15s samples. */
import path from 'node:path'
import { assertScratchDataDir } from '../platform/verify.lib.ts'
import { launchFixture } from '../requests/harness.ts'

assertScratchDataDir()
const label = process.argv[2] ?? 'after'
for (let run = 1; run <= 2; run++) {
  const f = await launchFixture(path.resolve('src/main.tsx'), { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: 'dark' })
  try {
    await f.app.getByTestId('environment-toggle').waitFor({ timeoutMs: 60000 })
    await f.app.getByTestId('environment-toggle').click()
    await f.app.getByTestId('environment-panel').waitFor()
    console.log(`${label} environment run ${run}: 10 s warmup`)
    await Bun.sleep(10000)
    const sample = Bun.spawn(['bun', 'perf/sample.ts', '15', `${label}-${run}=${f.pid}`], { stdout: 'inherit', stderr: 'inherit' })
    if (await sample.exited) throw Error('Performance sample failed')
  } finally { console.log(f.diagnostics()); await f.close() }
}
