import {readdirSync,writeFileSync,rmSync,mkdirSync,openSync,closeSync} from 'node:fs'
import path from 'node:path'
const root=path.resolve(import.meta.dir,'../../../..'),lane='perf-coldstart'
const marker=`/tmp/kybern-gpuix-native-build.${lane}`
const args=process.argv.slice(2),label=args.shift()!
const out='/Users/mymac/projects/ade/previews/gpuix/perf/coldstart'
mkdirSync(out,{recursive:true})
const reservation='/tmp/kybern-gpuix-build-next.'+lane
let stopped=false, child:ReturnType<typeof Bun.spawn>|undefined
for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>{stopped=true;child?.kill(signal)})
for(;!stopped;){
 const names=readdirSync('/tmp')
 if(!names.some(n=>n.startsWith('kybern-gpuix-build-next.'))){
  try{closeSync(openSync(reservation,'wx'));writeFileSync(reservation,`${lane} ${new Date().toISOString()} ${label}\n`)}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error}
 }
 const current=readdirSync('/tmp')
 if(current.includes(path.basename(reservation))&&!current.some(n=>n.startsWith('kybern-gpuix-quiet.')||n.startsWith('kybern-gpuix-native-build.')||n.startsWith('kybern-gpuix-build-next.')&&!n.endsWith(lane)))break
 await Bun.sleep(1000)
}
if(stopped){rmSync(reservation,{force:true});process.exit(130)}
writeFileSync(marker,`${lane} ${new Date().toISOString()}\n`)
try{
const running=Bun.spawn(['nice','-n','15',...args],{cwd:root,env:{...process.env,CARGO_TARGET_DIR:path.join(root,'target'),CARGO_INCREMENTAL:'0',CARGO_BUILD_JOBS:'4',RUSTC_WRAPPER:'',KYBERN_DATA_DIR:'/Users/mymac/projects/ade-gpuix-scratch/perf-coldstart',KYBERN_CLIENT_CONFIG_DIR:'/Users/mymac/projects/ade-gpuix-scratch/perf-coldstart/client'},stdout:'pipe',stderr:'pipe'})
child=running
const [stdout,stderr,code]=await Promise.all([new Response(running.stdout).text(),new Response(running.stderr).text(),running.exited])
writeFileSync(path.join(out,label+'.log'),stdout+'\n'+stderr)
console.log(JSON.stringify({label,code,tail:(stdout+stderr).slice(-2500)}));process.exitCode=code
}finally{rmSync(marker,{force:true});rmSync('/tmp/kybern-gpuix-build-next.'+lane,{force:true})}
