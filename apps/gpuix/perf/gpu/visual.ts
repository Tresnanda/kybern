import assert from 'node:assert/strict'
import {mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs'
import path from 'node:path'
import {seed} from '../bench/seed.ts'
import {launchFixture} from '../../src/requests/harness.ts'
import {pixels} from '../../native/png.ts'
import {screenState} from '../bench/screen-state.ts'
process.env.KYBERN_BENCH_SCREEN_STATE_SCRIPT??='/Users/mymac/projects/ade-gpuix-scratch/screen-state.swift'
const out='/Users/mymac/projects/ade/previews/gpuix/perf/gpu/visual';mkdirSync(out,{recursive:true})
const data='/Users/mymac/projects/ade-gpuix-scratch/perf-gpu-visual'
screenState('visual-before')
const fixture=await seed(data,4335)
const awake=Bun.spawn(['/usr/bin/caffeinate','-d','-i','-u','-w',String(process.pid),'-t','300'],{stdout:'ignore',stderr:'ignore'})
const results:unknown[]=[]
async function until<T>(fn:()=>Promise<T|false>,label:string):Promise<T>{for(let i=0;i<500;i++){const v=await fn();if(v)return v;await Bun.sleep(20)}throw Error(label)}
try {
 for(const theme of ['dark','light']) {
  const files:Record<string,string[]>={}
  for(const control of ['0','1']) {
   rmSync(path.join(data,'gpuix-ui.json'),{force:true})
   const client=path.join(data,`client-${theme}-${control}`);mkdirSync(client,{recursive:true})
   screenState('visual-app-before')
   const f=await launchFixture(path.resolve(import.meta.dir,'../bench/app.ts'),{...fixture.env,NAPI_RS_NATIVE_LIBRARY_PATH:path.resolve('native/build/gpuix-native.darwin-arm64.node'),KYBERN_CLIENT_CONFIG_DIR:client,KYBERN_GPUIX_CREDENTIALS_DIR:path.join(client,'credentials'),KYBERN_BENCH_WHEEL_LIBRARY:path.join(data,'bench-wheel.dylib'),KYBERN_GPU_CLIP_PRUNE:control,KYBERN_GPUIX_THREAD:'',KYBERN_APPEARANCE:theme,KYBERN_FULL_RATE:'1',KYBERN_REDUCED_MOTION:'0',KYBERN_PACING_IGNORE_PHYSICAL_MOUSE:'1',GPUIX_BACKGROUND:'1'})
   files[control]=[]
   try {
    await f.app.getByTestId('app-ready').waitFor()
    await until(async()=>{try{return JSON.parse(readFileSync(path.join(client,'bench-control.json'),'utf8')).port as number}catch{return false}},'control port')
    const port=JSON.parse(readFileSync(path.join(client,'bench-control.json'),'utf8')).port
    const call=async(action:string,args:Record<string,unknown>={})=>{const r=await fetch(`http://127.0.0.1:${port}`,{method:'POST',body:JSON.stringify({action,...args})});assert.ok(r.ok,await r.clone().text());return r.json()}
    await until(async()=>{const s=await call('state');return s.listsLoaded},'lists')
    await call('idle');await call('home');await Bun.sleep(1000)
    await f.app.clock.pause();await f.app.call('blur',{});await f.app.mouse.move({x:900,y:4})
    const shot=async(name:string)=>{await f.app.clock.fastForward(1000);await Bun.sleep(100);const file=`${out}/${theme}-${control}-${name}.png`;await f.app.screenshot({path:file});files[control]!.push(file)}
    await shot('sidebar')
    await f.app.mouse.wheel({x:180,y:430},0,-650);await shot('sidebar-scrolled')
    await call('open',{thread:fixture.manifest.long3000});await f.app.getByTestId('transcript-surface').waitFor();await Bun.sleep(1000)
    await shot('transcript')
    const b=await f.app.getByTestId('transcript-surface').bounds();await f.app.mouse.wheel({x:b.x+b.width/2,y:b.y+b.height/2},0,650);await shot('transcript-scrolled')
    await call('explorer',{file:fixture.manifest.markdown});await f.app.getByTestId('dock-file-content').waitFor();await Bun.sleep(1000)
    const tree=await f.app.getByTestId('dock-file-tree-focus').bounds();for(let settle=0;settle<2;settle++){await f.app.mouse.wheel({x:tree.x+100,y:tree.y+tree.height/2},0,1000000);await f.app.clock.fastForward(1000);await Bun.sleep(250)}
    await shot('markdown')
    const d=await f.app.getByTestId('right-dock').bounds();await f.app.mouse.wheel({x:d.x+d.width-90,y:d.y+d.height/2},0,-650);await shot('markdown-scrolled')
    await call('dock-close');await call('explorer');await f.app.getByTestId('dock-file-tree-focus').waitFor();await Bun.sleep(300)
    await f.app.getByTestId('dock-file-expanded').click();await Bun.sleep(500);await shot('explorer')
   }finally{await f.close();screenState('visual-app-after')}
  }
  for(let i=0;i<files['0']!.length;i++) {
   const before=files['0']![i]!,after=files['1']![i]!,a=pixels(before),b=pixels(after)
   assert.equal(a.w,b.w);assert.equal(a.h,b.h)
   let changed=0,max=0,sampled=0
   for(let y=4;y<a.h-4;y++)for(let x=4;x<a.w-4;x++){
    if(y>a.h-52&&(x<52||x>a.w-52))continue
    sampled++;const p=a.at(x,y),q=b.at(x,y);const delta=Math.max(...p.map((v,j)=>Math.abs(v-q[j]!)));if(delta)changed++;max=Math.max(max,delta)
   }
   const r={theme,before,after,sampled,changed,max};results.push(r);console.log(JSON.stringify(r))
  }
 }
 writeFileSync(out+'/pixel-diff.json',JSON.stringify(results,null,2))
 for(const r of results as {changed:number;before:string}[])assert.equal(r.changed,0,r.before)
}finally{await fixture.close();fixture.remove();awake.kill();await awake.exited;screenState('visual-after')}
