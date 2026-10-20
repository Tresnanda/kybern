import {requireScreen} from '../bench/screen-state.ts'
import {launchFixture} from '../../src/requests/harness.ts'
import {Telemetry} from '../bench/telemetry.ts'
import {writeFileSync} from 'node:fs'
import {lease} from '../bench/lease.ts'
const results=[]
for(const scene of ['matrix','spin','shimmer','skeleton']){
 const release=await lease(),t=new Telemetry()
 const fixture=await launchFixture(`${import.meta.dir}/loops-app.tsx`,{
  KYBERN_DATA_DIR:'/Users/mymac/projects/ade-gpuix-scratch/perf-cadence-loops',KYBERN_CLIENT_CONFIG_DIR:'/Users/mymac/projects/ade-gpuix-scratch/perf-cadence-loops/client',
  KYBERN_URL:'',KYBERN_TOKEN:'',GPUIX_BACKGROUND:'1',KYBERN_FRAME_TIMES:'1',KYBERN_FULL_RATE:'1',CADENCE_LOOP:scene,CADENCE_VISIBILITY_CONTROL:'0',KYBERN_NATIVE_PAINT_ANIMATIONS:'0',
 },{stderr:t.stderr})
 try{
  const root=fixture.app.getByTestId('app-ready');await root.waitFor();await fixture.app.call('blur',{});await Bun.sleep(1000)
  let mark=t.mark();await Bun.sleep(1200);const visible=t.result(mark).frames.count
  await root.press('o');await Bun.sleep(1000);mark=t.mark();await Bun.sleep(1200);const clipped=t.result(mark).frames.count
  requireScreen()
  results.push({scene,visible,clipped})
  if(!visible||clipped)throw Error(`${scene}: visible=${visible}, clipped=${clipped}`)
 }finally{await fixture.close();release()}
}
writeFileSync('/Users/mymac/projects/ade/previews/gpuix/perf/cadence/diagnostics/paint-visibility-smoke.json',JSON.stringify(results,null,2))
console.log('PASS native div / SVG / text paint-observer visibility')
