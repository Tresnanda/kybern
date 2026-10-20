import {readFileSync,mkdirSync} from 'node:fs'
import {launchFixture} from '../../src/requests/harness.ts'
const data='/Users/mymac/projects/ade-gpuix-scratch/perf-transcript'
const out='/Users/mymac/projects/ade/previews/gpuix/perf/transcript'
mkdirSync(data,{recursive:true})
for(const coalesce of ['pr','0']){
 const f=await launchFixture(import.meta.dir+'/entry.ts',{TRANSCRIPT_TURNS:'3000',KYBERN_DATA_DIR:data,KYBERN_CLIENT_CONFIG_DIR:data,KYBERN_URL:'',KYBERN_TOKEN:'',KYBERN_APPEARANCE:'dark',KYBERN_OPAQUE:'1',GPUIX_BACKGROUND:'1',KYBERN_FULL_RATE:'1',KYBERN_SCROLL_COALESCE:coalesce})
 try{
  const a=f.app
  await a.getByTestId('perf-ready').waitFor();await Bun.sleep(1500)
  const port=JSON.parse(readFileSync(data+'/transcript-control.json','utf8')).port
  const command=async(action:string,args:object={})=>(await fetch(`http://127.0.0.1:${port}`,{method:'POST',body:JSON.stringify({action,...args})})).json()
  const surface=await a.getByTestId('transcript-surface').bounds(),list=await a.getByTestId('transcript').bounds()
  const point={x:surface.x+surface.width/2,y:surface.y+surface.height/2}
  console.log('DIAG initial',JSON.stringify({coalesce,surface,list,where:await command('where')}))
  await a.screenshot({path:`${out}/diag-3000-${coalesce}-before.png`})
  await command('wheel-drive',{durationMs:4000,allPackets:true,...point});await Bun.sleep(500)
  console.log('DIAG AppKit',JSON.stringify({coalesce,where:await command('where')}))
  await a.mouse.wheel(point,0,1000);await Bun.sleep(500)
  console.log('DIAG RPC positive',JSON.stringify({coalesce,where:await command('where')}))
  await a.mouse.wheel(point,0,-1800);await Bun.sleep(500)
  console.log('DIAG RPC negative',JSON.stringify({coalesce,where:await command('where')}))
  await a.screenshot({path:`${out}/diag-3000-${coalesce}-after.png`})
 }finally{await f.close()}
}
