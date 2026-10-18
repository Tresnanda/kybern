import assert from 'node:assert/strict'
import {mkdirSync} from 'node:fs'
import {launchFixture} from '../../src/requests/harness.ts'
import {pixels} from '../../native/png.ts'
const root='/Users/mymac/projects/ade/previews/gpuix/perf/transcript/p1-visual';mkdirSync(root,{recursive:true})
const data='/Users/mymac/projects/ade-gpuix-scratch/perf-transcript'
for(const theme of ['dark','light'])for(const reduced of ['0','1']){
 const snapshots:Record<string,string[]>={}
 for(const [label,layout,baseline] of [['0','0','1'],['window','0','0'],['1','1','0']] as const){
  const f=await launchFixture(import.meta.dir+'/entry.ts',{TRANSCRIPT_TURNS:'1000',TRANSCRIPT_BASELINE:baseline,KYBERN_TRANSCRIPT_LAYOUT:layout,KYBERN_SCROLL_COALESCE:'pr',KYBERN_DATA_DIR:data,KYBERN_CLIENT_CONFIG_DIR:data,KYBERN_URL:'',KYBERN_TOKEN:'',KYBERN_OPAQUE:'1',KYBERN_APPEARANCE:theme,KYBERN_REDUCED_MOTION:reduced,GPUIX_BACKGROUND:'1'})
  const files:string[]=[]
  try{
   const a=f.app;await a.getByTestId('perf-ready').waitFor();await Bun.sleep(500);await a.clock.pause()
   const b=await a.getByTestId('transcript-surface').bounds(),point={x:b.x+b.width/2,y:b.y+b.height/2}
   for(const [i,delta] of [0,180,220,-120].entries()){
    if(delta)await a.mouse.wheel(point,0,delta)
    await Bun.sleep(100);await a.clock.fastForward(700);await Bun.sleep(50)
    const text=(await a.call('getPaintedText',{})).text.join('\n');assert.ok(/row|BENCH_RESULT|Paint|Result|reading/.test(text),'Formatted content survives cached scroll')
    const file=`${root}/${theme}-${reduced}-${label}-${i}.png`;await a.screenshot({path:file});files.push(file)
   }
  }finally{await f.close()}
  snapshots[label]=files
 }
 for(const reference of ['0','window'])for(let i=0;i<snapshots[reference]!.length;i++){
  const a=pixels(snapshots[reference]![i]!),b=pixels(snapshots['1']![i]!);assert.equal(a.w,b.w);assert.equal(a.h,b.h)
  const scale=a.w/1280
  let changed=0,railChanged=0;for(let y=4;y<a.h-4;y++)for(let x=4;x<a.w-4;x++){if(y>a.h-52&&(x<52||x>a.w-52))continue;const p=a.at(x,y),q=b.at(x,y);if(p.some((v,j)=>v!==q[j])){if(reference==='0'&&x>=20*scale&&x<48*scale)railChanged++;else changed++}}
  // The old source leaves its rail on message zero after initial follow-tail.
  // Its corrected highlight intentionally differs. Every content pixel must
  // match, and the windowed cache-off control also requires the entire rail.
  console.log(JSON.stringify({theme,reduced,reference:reference==='0'?'baseline':'window-cache-off',step:i,changedPixels:changed,railChangedPixels:railChanged}));assert.equal(changed,0,'Transcript content or cache-control pixels differ')
 }
}
