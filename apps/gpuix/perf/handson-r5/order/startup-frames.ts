// Separate visual pass: screenshots are deliberately excluded from benchmarks.
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs'
import {seed} from '../../bench/seed.ts'
import {launchFixture} from '../../../src/requests/harness.ts'
import {requireScreen} from '../../bench/screen-state.ts'
import {waitForWindowOnscreen,requireWindowOnscreen} from '../../bench/window-onscreen.ts'
import {prepareBaseline} from './baseline.ts'
const label=process.argv[2]??'after',out='/Users/mymac/projects/ade/previews/gpuix/handson-r5/order',data='/Users/mymac/projects/ade-gpuix-scratch/hr5-order-bench'
if(label==='before')prepareBaseline()
const fixture=await seed(data,4343)
try{for(const theme of ['dark','light'])for(const temperature of ['cold','warm']){
 requireScreen();await fixture.restart()
 if(temperature==='warm')await fixture.client.call('threads.get',{thread_id:fixture.manifest.long3000,transcript_limit:120,include_tool_output:false})
 const prefs=JSON.parse(readFileSync(data+'/gpuix-ui.json','utf8'))
 prefs['kybern.split-view.v1']={version:1,root:{kind:'leaf',id:'main',threadId:fixture.manifest.long3000},focusedPaneId:'main'}
 delete prefs['kybern.window.frame'];writeFileSync(data+'/gpuix-ui.json',JSON.stringify(prefs))
 const dir=`${out}/${label}-startup-${theme}-${temperature}`;mkdirSync(dir,{recursive:true})
 const frames:unknown[]=[],started=performance.now()
 const f=await launchFixture(import.meta.dir+'/entry.ts',{...fixture.env,HR5_ORDER_BASELINE:label==='before'?'1':'0',GPUIX_BACKGROUND:'1',KYBERN_OPAQUE:'1',KYBERN_APPEARANCE:theme,KYBERN_STARTUP_TRACE:'1',KYBERN_GPUIX_THREAD:'',KYBERN_BENCH_WHEEL_LIBRARY:data+'/bench-wheel.dylib'})
 try{
  await f.app.getByTestId('app-ready').waitFor();await waitForWindowOnscreen(f.pid)
  let complete=0,last=0,index=0
  const deadline=performance.now()+15000
  while(performance.now()<deadline){
   // The placement check above covers the first capture. For subsequent
   // images check placement before polling paint, so slow Swift startup cannot
   // label a later screenshot with an earlier sidebar observation.
   if(index>0)requireWindowOnscreen(f.pid)
   const text=(await f.app.call('getPaintedText',{})).text.join('\n'),ms=performance.now()-started
   const sidebar=text.includes('Bench project'),content=/BENCH_RESULT_\d+|Result \d+/.test(text)
   const milestone=Number(sidebar)+Number(content)*2
   if(index===0||milestone!==last||ms-(frames.at(-1) as any)?.ms>=120){
    const file=`${String(index++).padStart(2,'0')}-${Math.round(ms)}ms.png`
    await f.app.screenshot({path:dir+'/'+file})
    const captured=(await f.app.call('getPaintedText',{})).text.join('\n')
    frames.push({ms,file,sidebar:captured.includes('Bench project'),content:/BENCH_RESULT_\d+|Result \d+/.test(captured),observedBefore:{sidebar,content}});last=milestone
   }
   if(sidebar&&content){if(complete++>2)break}
   await Bun.sleep(25)
  }
  writeFileSync(dir+'/frames.json',JSON.stringify(frames,null,2));requireScreen()
 }finally{await f.close()}
}}finally{await fixture.close()}
