/** Final same-addon controls after motion and ownership correctness passes. */
import {existsSync,mkdirSync,copyFileSync,readdirSync} from 'node:fs'
const out='/Users/mymac/projects/ade/previews/gpuix/perf/scroll2'
if(!existsSync(out+'/native-passed.json'))throw Error('Complete the native updater first')
for(const [folder,match] of [['transcript',/^(dense|sparse|diagnostic)(-synthetic)?-/],['sidebar',/^(dense|sparse)-(fast|settled)-/],['',/^bench-(dense|sparse)\.json$/]] as const){
 const from=out+(folder?'/'+folder:''),to=out+'/initial-metrics'+(folder?'/'+folder:'');mkdirSync(to,{recursive:true})
 for(const name of readdirSync(from))if(match.test(name)&&!existsSync(to+'/'+name))copyFileSync(from+'/'+name,to+'/'+name)
}
async function run(command:string[]){const child=Bun.spawn(command,{env:process.env,stdin:'inherit',stdout:'inherit',stderr:'inherit'});for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>child.kill(signal));if(await child.exited)throw Error(command.join(' ')+' failed')}
await run(['pnpm','typecheck']);await run(['pnpm','exec','tsc','-p','perf/scroll2/tsconfig.json'])
await run(['bun','perf/scroll2/metrics.ts'])
await run(['python3','perf/scroll2/summarize.py'])
export {}

await run(['python3','perf/scroll2/profiles.py'])

await run(['python3','perf/scroll2/cleanup.py'])
