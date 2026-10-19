import assert from 'node:assert/strict'
import {mkdirSync,writeFileSync} from 'node:fs'
import {launchFixture} from '../../src/requests/harness.ts'
import {pixels} from '../../native/png.ts'
const root='/Users/mymac/projects/ade/previews/gpuix/perf/flick/visual';mkdirSync(root,{recursive:true})
const data='/Users/mymac/projects/ade-gpuix-scratch/perf-flick-visual'
const comparisons:unknown[]=[]
for(const theme of ['dark','light'])for(const reduced of ['0','1']){
 const snapshots:Record<string,string[]>={}
 for(const [label,layout,baseline] of [['frame0','1','0'],['frame1','1','0']] as const){
  const f=await launchFixture(import.meta.dir+'/../transcript/entry.ts',{TRANSCRIPT_TURNS:'1000',KYBERN_INPUT_FRAME_DRAW:label==='frame1'?'1':'0',TRANSCRIPT_BASELINE:baseline,KYBERN_TRANSCRIPT_LAYOUT:layout,KYBERN_SCROLL_COALESCE:'pr',KYBERN_DATA_DIR:data,KYBERN_CLIENT_CONFIG_DIR:data,KYBERN_URL:'',KYBERN_TOKEN:'',KYBERN_OPAQUE:'1',KYBERN_APPEARANCE:theme,KYBERN_REDUCED_MOTION:reduced,GPUIX_BACKGROUND:'1'})
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
 for(const reference of ['frame0'])for(let i=0;i<snapshots[reference]!.length;i++){
  const a=pixels(snapshots[reference]![i]!),b=pixels(snapshots['frame1']![i]!);assert.equal(a.w,b.w);assert.equal(a.h,b.h)
  const scale=a.w/1280
  let changed=0,railChanged=0;for(let y=4;y<a.h-4;y++)for(let x=4;x<a.w-4;x++){if(y>a.h-52&&(x<52||x>a.w-52))continue;const p=a.at(x,y),q=b.at(x,y);if(p.some((v,j)=>v!==q[j])){changed++}}
  const result={theme,reduced,reference,step:i,changedPixels:changed,railChangedPixels:railChanged};comparisons.push(result);console.log(JSON.stringify(result));assert.equal(changed,0,'Transcript pixels differ')
 }
}

writeFileSync(root+'/pixel-diff.json',JSON.stringify(comparisons,null,2))
