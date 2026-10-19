import assert from 'node:assert/strict'
import path from 'node:path'
import {mkdirSync,existsSync,readFileSync,writeFileSync} from 'node:fs'
import {seed} from '../bench/seed.ts'
import {launchFixture} from '../../src/requests/harness.ts'
import {Telemetry} from '../bench/telemetry.ts'
import {requireScreen,keepDisplayAwake} from '../bench/screen-state.ts'
import {onExit} from '../bench/lifetime.ts'
const out='/Users/mymac/projects/ade/previews/gpuix/perf/backdrop/stream-visual'
mkdirSync(out,{recursive:true});requireScreen();const stop=keepDisplayAwake(),audit:unknown[]=[]
const fixture=await seed('/Users/mymac/projects/ade-gpuix-scratch/perf-backdrop-stream-visual',4337)
async function until(check:()=>Promise<boolean>,message:string){const end=Date.now()+30000;while(!await check()){if(Date.now()>end)throw Error(message);await Bun.sleep(40)}}
try{for(const theme of ['dark','light'])for(const kernel of ['0','1']){
 requireScreen();const telemetry=new Telemetry(),client=path.join(fixture.data,'client',theme+kernel);mkdirSync(client,{recursive:true})
 const f=await launchFixture(path.resolve(import.meta.dir,'../bench/app.ts'),{...fixture.env,KYBERN_CLIENT_CONFIG_DIR:client,KYBERN_GPUIX_CREDENTIALS_DIR:path.join(client,'credentials'),KYBERN_GPUIX_THREAD:'',KYBERN_APPEARANCE:theme,KYBERN_BACKDROP_KERNEL:kernel,KYBERN_FULL_RATE:'1',KYBERN_GPU_TRACE:'1',KYBERN_FRAME_TIMES:'1',KYBERN_BENCH_STREAM_CATCHUP:'1',GPUIX_BACKGROUND:'1',KYBERN_PACING_IGNORE_PHYSICAL_MOUSE:'1'},{stderr:telemetry.stderr})
 const unregister=onExit(()=>f.close())
 try{
  await f.app.getByTestId('app-ready').waitFor()
  await until(async()=>existsSync(path.join(client,'bench-control.json')),'Missing stream controller')
  const port=JSON.parse(readFileSync(path.join(client,'bench-control.json'),'utf8')).port
  const control=async(action:string,args:Record<string,unknown>={})=>{const res=await fetch(`http://127.0.0.1:${port}`,{method:'POST',body:JSON.stringify({action,...args})});if(!res.ok)throw Error(await res.text());return await res.json()}
  await until(async()=>(await control('state')).listsLoaded,'Lists not loaded')
  await control('open',{thread:fixture.manifest.running});await f.app.getByTestId('transcript-surface').waitFor()
  const streamStart=telemetry.raw.length
  await control('stream',{durationMs:8000})
  await until(async()=>/Streaming paragraph/.test((await f.app.call('getPaintedText',{})).text.join(' ')),'Stream text not painted')
  for(const frame of [1,2]){await Bun.sleep(700);await f.app.screenshot({path:`${out}/${theme}-${kernel}-${frame}.png`})}
  assert.ok(/\[backdrop-kernel\]/.test(telemetry.raw.slice(streamStart)),'Streaming must exercise blur passes')
  audit.push({theme,kernel,screen:requireScreen(),streamDeltas:(await control('state')).streamDeltas,backdropRecords:telemetry.raw.slice(streamStart).match(/\[backdrop-kernel\]/g)?.length})
 }finally{await f.close();unregister();writeFileSync(`${out}/${theme}-${kernel}.log`,telemetry.raw)}
}writeFileSync(out+'/results.json',JSON.stringify(audit,null,2))}finally{await fixture.close();fixture.remove();stop()}
