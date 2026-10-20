import {mkdirSync,readdirSync,writeFileSync} from 'node:fs'
import path from 'node:path'
const out='/Users/mymac/projects/ade/previews/gpuix/perf/coldstart'
mkdirSync(out,{recursive:true})
async function run(phase:string,mode:string,i:number,appearance='dark'){
 const file=path.join(out,`${process.env.KYBERN_COLDSTART_LABEL??''}${phase}-${mode}-${appearance}-${i}.json`)
 const args=mode==='profile'?['bun','perf/coldstart/profile.ts',file]:['bun','perf/coldstart/measure.ts',file,'--packaged',...(mode==='timing'?['--history','--open-thread']:['--'+mode])]
 const child=Bun.spawn(['bun','perf/coldstart/lease.ts','--','bun','perf/coldstart/fixture.ts','--',...args],{env:{...process.env,KYBERN_TEST_DAEMON:path.resolve(`dist/coldstart-${phase}.app/Contents/MacOS/kybernd`),KYBERN_STARTUP_EXECUTABLE:path.resolve(`dist/coldstart-${phase}.app/Contents/MacOS/Kybern GPUIX`),KYBERN_STARTUP_RUNS:mode==='timing'?'2':'1',KYBERN_STARTUP_INPUT_HZ:'30',KYBERN_STARTUP_VISUAL_SETTLE_MS:'20000',KYBERN_APPEARANCE:appearance},stdout:'inherit',stderr:'inherit'})
 for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>child.kill(signal))
 if(await child.exited)throw Error(`Failed ${file}`)
}
const mode=process.argv[2]??'timing',phases=process.argv.slice(3)
for(let i=0;i<(mode==='timing'?Number(process.env.KYBERN_COLDSTART_PAIRS??5):1);i++)for(const phase of i%2?[...phases].reverse():phases)for(const theme of mode==='visuals'?['dark','light']:['dark'])await run(phase,mode,i,theme)

if(process.env.KYBERN_COLDSTART_LABEL==='preliminary-')for(const phase of phases)await run(phase,'profile',0)
if(process.env.KYBERN_COLDSTART_LABEL==='preliminary-'&&!readdirSync('/tmp').some(n=>n.startsWith('kybern-gpuix-build-next.')))
 writeFileSync('/tmp/kybern-gpuix-build-next.perf-coldstart',`perf-coldstart ${new Date().toISOString()} next replay experiment after preliminary measurements\n`)
