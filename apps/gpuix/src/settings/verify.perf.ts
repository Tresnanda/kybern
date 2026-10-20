/** Full Settings navigation, two 10s warmups and 15s samples. Explicit scratch only. */
import path from 'node:path'
import { launchFixture } from '../requests/harness.ts'
if (!process.env.KYBERN_DATA_DIR?.includes('gpuix-scratch')) throw Error('Use scratch data')
for (let run = 1; run <= 2; run++) {
 const f = await launchFixture(path.join(import.meta.dir, '../main.tsx'), { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: 'dark' })
 try {
  await f.app.getByTestId('app-ready').waitFor({timeoutMs:60000})
  await f.app.getByTestId('rail-settings').click()
  await f.app.getByTestId('settings-worktrees').waitFor()
  await Bun.sleep(10000)
  const sample = Bun.spawn(['bun', path.join(import.meta.dir, '../../perf/sample.ts'), '15', `Settings-${run}=${f.pid}`], {stdout:'inherit', stderr:'inherit'})
  const end = Date.now()+15000; let i=0
  while(Date.now()<end) { await f.app.getByTestId(`settings-tab-${i++%2?'general':'appearance'}`).click(); await Bun.sleep(500) }
  if(await sample.exited) throw Error('Sample failed')
 } finally { await f.close() }
}
