import assert from 'node:assert/strict'
import path from 'node:path'
import {mkdirSync,writeFileSync} from 'node:fs'
import {launchFixture} from '../../src/requests/harness.ts'
import {pixels} from '../../native/png.ts'
import {requireScreen,keepDisplayAwake} from '../bench/screen-state.ts'
const out='/Users/mymac/projects/ade/previews/gpuix/perf/backdrop/kernel-visual'
mkdirSync(out,{recursive:true});requireScreen();const stop=keepDisplayAwake(),results:unknown[]=[]
try{
 for(const theme of ['dark','light'])for(const mode of ['opaque','translucent','reduced-transparency','increased-contrast']){
  const files:Record<string,string[]>={}
  for(const kernel of ['0','1']){
   requireScreen()
   const f=await launchFixture(path.resolve(import.meta.dir,'kernel-lab.tsx'),{KYBERN_DATA_DIR:'/Users/mymac/projects/ade-gpuix-scratch/perf-backdrop-kernel',KYBERN_CLIENT_CONFIG_DIR:'/Users/mymac/projects/ade-gpuix-scratch/perf-backdrop-kernel/client',KYBERN_URL:'',KYBERN_TOKEN:'',GPUIX_BACKGROUND:'1',KYBERN_FULL_RATE:'1',KYBERN_APPEARANCE:theme,KYBERN_BACKDROP_KERNEL:kernel,KYBERN_OPAQUE:mode==='opaque'?'1':'0',KYBERN_REDUCED_TRANSPARENCY:mode==='reduced-transparency'?'1':'0',KYBERN_INCREASED_CONTRAST:mode==='increased-contrast'?'1':'0'})
   files[kernel]=[]
   try{
    await f.app.getByTestId('app-ready').waitFor();await Bun.sleep(400)
    const root=(await f.app.getByTestId('app-ready').element()).id;await f.app.call('focus',{elementId:root});await f.app.call('blur',{})
    for(const state of ['still','moved']){
     if(state==='moved'){await f.app.call('focus',{elementId:root});await f.app.call('keyDown',{key:'s'});await f.app.call('blur',{});await Bun.sleep(200)}
     const file=`${out}/${theme}-${mode}-${kernel}-${state}.png`;await f.app.screenshot({path:file});files[kernel]!.push(file)
    }
   }finally{await f.close();requireScreen()}
  }
  for(let i=0;i<2;i++){
   const before=files['0']![i]!,after=files['1']![i]!,a=pixels(before),b=pixels(after)
   assert.equal(a.w,b.w);assert.equal(a.h,b.h)
   let max=0,changed=0,over2=0,over4=0,total=0,sum=0
   for(let y=12;y<a.h-12;y++)for(let x=12;x<a.w-12;x++){
    const p=a.at(x,y),q=b.at(x,y),d=Math.max(...p.map((v,j)=>Math.abs(v-q[j]!)));total++;max=Math.max(max,d);sum+=d;if(d)changed++;if(d>2)over2++;if(d>4)over4++
   }
   const row={theme,mode,before,after,total,max,changed,over2,over4,meanMaxDelta:sum/total};results.push(row);writeFileSync(out+'/results.json',JSON.stringify(results,null,2));console.log(JSON.stringify(row));assert.equal(over4,0,'Equivalent kernel changed visible output')
  }
 }
}finally{stop()}
