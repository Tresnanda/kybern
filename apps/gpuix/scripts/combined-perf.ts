/** Fresh full-app scenes, no screenshots; 10 s warm-up + 15 s sample, twice. */
import path from 'node:path'
import { writeFileSync } from 'node:fs'
import { launchFixture } from '../src/requests/harness.ts'
const data = process.env.KYBERN_DATA_DIR
if (!data || (!data.includes('gpuix-scratch') && !data.endsWith('/apps/gpuix/.combined/data'))) throw Error('Use an isolated scratch daemon')
const thread = process.env.KYBERN_GPUIX_THREAD
if (!thread) throw Error('Select a populated scratch thread')
const modes = process.argv.includes('--old') ? ['active'] : ['home', 'thread', 'active', 'settings']
const sample = async (pid: number, seconds: number, label: string, quiet = false) => {
 const child = Bun.spawn(['bun', path.join(import.meta.dir, '../perf/sample.ts'), String(seconds), `${label}=${pid}`], { stdout: quiet ? 'ignore' : 'inherit', stderr: 'inherit' })
 if (await child.exited !== 0) throw Error('Sample failed')
}
for (const mode of modes) for (let run=1; run<=2; run++) {
 // Every measurement has the same initial frame, dock and sidebar state.
 writeFileSync(path.join(data, 'gpuix-ui.json'), '{}')
 const f = await launchFixture(path.join(import.meta.dir, mode === 'active' ? 'native-perf-fixture.tsx' : '../src/main.tsx'), {
  GPUIX_BACKGROUND: '1', KYBERN_DATA_DIR: data, KYBERN_URL: '', KYBERN_TOKEN: '',
  KYBERN_GPUIX_THREAD: mode === 'thread' || mode === 'active' ? thread : '',
  KYBERN_APPEARANCE: 'dark', KYBERN_LOADER_TICK_MS: '200',
 })
 try {
  const a=f.app
  await a.getByTestId('app-ready').waitFor({ timeoutMs: 60000 })
  await a.getByTestId('composer').waitFor({ timeoutMs: 60000 })
  if(mode === 'active') await a.getByTestId('working-header').waitFor({timeoutMs:60000})
  if(mode === 'settings') { await a.getByTestId('rail-settings').click(); await a.getByTestId('settings-worktrees').waitFor() }
  console.log(`WARMUP ${mode} run ${run}`)
  await sample(f.pid,10,'Warmup',true)
  console.log(`SAMPLE ${mode} run ${run}`)
  const sampling=sample(f.pid,15,`${process.argv.includes('--old')?'Old':'Current'}-${mode}-${run}`)
  if(mode === 'settings') {
   const end=Date.now()+15000;let changes=0
   while(Date.now()<end) { await a.getByTestId(`settings-tab-${changes%2?'general':'appearance'}`).click();changes++;await Bun.sleep(500) }
   console.log(`Settings navigation actions: ${changes}`)
  }
  await sampling
  if(mode==='active') await a.getByTestId('working-header').waitFor({timeoutMs:1000})
 } finally { console.log(f.diagnostics());await f.close() }
}
