/** Verify the shared frame reconciliation with the production surfaces. */
import {existsSync,readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
while(existsSync('/tmp/kybern-gpuix-native-build.perf-scroll2'))await Bun.sleep(1000)
if(!existsSync('/Users/mymac/projects/ade/previews/gpuix/perf/scroll2/native-passed.json'))throw Error('Native updater must pass first')
const passed=JSON.parse(readFileSync('/Users/mymac/projects/ade/previews/gpuix/perf/scroll2/native-passed.json','utf8'))
if(!passed.passed||passed.sha256!==createHash('sha256').update(readFileSync('native/build/gpuix-native.darwin-arm64.node')).digest('hex'))throw Error('Native success stamp does not match the loaded addon')
async function run(command:string[]){const child=Bun.spawn(command,{env:process.env,stdin:'inherit',stdout:'inherit',stderr:'inherit'});for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>child.kill(signal));if(await child.exited)throw Error(command.join(' ')+' failed')}
for(const file of ['verify-list.ts','verify-transcript.ts','visual.ts','regressions.ts'])await run(['bun','perf/scroll2/lease.ts','bun','perf/scroll2/'+file])
await run(['env','TRANSCRIPT_COMPACT=1','bun','perf/scroll2/lease.ts','bun','perf/scroll2/verify-transcript.ts'])
for(const file of ['validate-mixed.ts','validate-visual.ts'])await run(['bun','perf/scroll2/fixture.ts','bun','perf/scroll2/'+file])
await run(['python3','perf/scroll2/task-checks.py'])
await run(['bun','perf/scroll2/pixels.ts'])
await run(['env','SCROLL2_CACHE_FIXED=1','bun','perf/scroll2/reproduce-cache.ts'])
export {}
