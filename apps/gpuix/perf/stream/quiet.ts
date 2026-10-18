import {existsSync,readdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs'
import {execFileSync} from 'node:child_process'
import {onExit} from '../bench/lifetime.ts'
const lane='perf-stream',marker=`/tmp/kybern-gpuix-quiet.${lane}`,order='/tmp/kybern-gpuix-quiet-order'
const evidence='/Users/mymac/projects/ade/previews/gpuix/perf/stream/quiet.json'
const edit=(add:boolean)=>execFileSync('python3',['-c',`from pathlib import Path
p=Path(${JSON.stringify(order)})
a=p.read_text().splitlines() if p.exists() else []
lane=${JSON.stringify(lane)}
if ${add?'True':'False'}:
 if lane not in a:a.append(lane)
else:a=[x for x in a if x!=lane]
p.write_text(chr(10).join(a)+(chr(10) if a else ''))`])
edit(true)
let held=false,started=''
const cleanup=()=>{if(held){rmSync(marker);held=false;writeFileSync(evidence,JSON.stringify({lane,startedAt:started,endedAt:new Date().toISOString()},null,2))}edit(false)}
const unregister=onExit(cleanup)
try{
 for(;;){
  const names=readdirSync('/tmp'),legacy=names.filter(n=>n.startsWith('kybern-gpuix-quiet-next.')).map(n=>n.slice('kybern-gpuix-quiet-next.'.length))
  const first=legacy[0]??(existsSync(order)?readFileSync(order,'utf8').split('\n').find(Boolean):null)
  if(first===lane&&!names.some(n=>['kybern-gpuix-quiet.','kybern-gpuix-native-build.','kybern-gpuix-build-next.'].some(prefix=>n.startsWith(prefix)))){
   started=new Date().toISOString();writeFileSync(marker,JSON.stringify({lane,startedAt:started,expectedEndMinutes:24}),{flag:'wx'});held=true;break
  }
  await Bun.sleep(1000)
 }
 const command=process.argv.slice(2);if(!command.length)throw Error('Pass the final measurement command')
 const child=Bun.spawn(command,{env:process.env,stdout:'inherit',stderr:'inherit'})
 const stop=onExit(async()=>{child.kill('SIGTERM');await child.exited})
 const timer=setTimeout(()=>child.kill('SIGTERM'),24*60_000)
 const code=await child.exited;clearTimeout(timer);stop();if(code)throw Error(`Final measurement failed (${code})`)
}finally{cleanup();unregister()}
