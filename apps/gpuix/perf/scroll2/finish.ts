/** Resume only after the already running cached-range diagnostic completes. */
import {existsSync,readFileSync,writeFileSync} from 'node:fs'
const out='/Users/mymac/projects/ade/previews/gpuix/perf/scroll2'
const paths=['0','1'].map(flag=>out+'/scroll2-cache-repro-fixed-'+flag+'.json')
const deadline=Date.now()+20*60*1000
while(paths.some(file=>!existsSync(file))){if(Date.now()>deadline)throw Error('Cached-range diagnostic did not finish');await Bun.sleep(1000)}
const native=JSON.parse(readFileSync(out+'/native-passed.json','utf8'))
for(const file of paths){const d=JSON.parse(readFileSync(file,'utf8'));if(d.addonSha256!==native.sha256||d.results.length!==4||d.results.some((v:{status:string})=>v.status!=='ok'))throw Error('Cached-range diagnostic failed: '+file)}
async function run(command:string[]){const child=Bun.spawn(command,{env:process.env,stdin:'inherit',stdout:'inherit',stderr:'inherit'});for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>child.kill(signal));if(await child.exited)throw Error(command.join(' ')+' failed')}
await run(['bun','perf/scroll2/fixture.ts','bun','perf/scroll2/validate-visual.ts'])
await run(['bun','perf/scroll2/pixels.ts'])
writeFileSync(out+'/verification.json',JSON.stringify({native,productChecks:'revalidate-native8.log: all product verifiers passed; its final pixel assertion rejected two dark hover-state screenshots',visualRetry:'finish.log: paired pointer state normalized, all eight comparisons exact',cacheRetry:paths,passed:true},null,2))
await run(['bun','perf/scroll2/quiet.ts','bun','perf/scroll2/final.ts'])
export {}
