import {spawn} from 'node:child_process'
import {writeFileSync} from 'node:fs'
import {launchFixture} from '../src/requests/harness.ts'
import {actionFixture} from '../src/pulls/verify.fixture.ts'
import {pacingLock,waitForNativeBuilds} from './scroll8-lock.ts'
import path from 'node:path'
await waitForNativeBuilds()
const release=await pacingLock(),fixture=actionFixture({long:true})
try{
 const f=await launchFixture(path.join(import.meta.dir,'pacing-app.ts'),{...fixture.env,KYBERN_FRAME_TIMES:'1',KYBERN_FRAME_COSTS:'1',KYBERN_FULL_RATE:'1'})
 try{
  const a=f.app;await a.getByTestId('app-ready').waitFor();await a.getByTestId('rail-pulls').click();await a.getByTestId('pr-row-108').click();await a.getByTestId('pr-summary').waitFor()
  const b=await a.getByTestId('page-pulls').bounds(),point={x:b.x+b.width-120,y:b.y+b.height/2}
  await Promise.all(Array.from({length:120},()=>a.mouse.wheel(point,0,-2)))
  let last=f.frameTimes().length,stable=performance.now();const deadline=stable+10000
  while(performance.now()-stable<1000){if(performance.now()>deadline)throw Error('PR never became idle');await Bun.sleep(25);const n=f.frameTimes().length;if(n!==last){last=n;stable=performance.now()}}
  const frames=f.frameTimes().length
  const sample=spawn('bun',[path.join(import.meta.dir,'sample.ts'),'15',`GPUIX=${f.pid}`],{stdio:['ignore','pipe','pipe']})
  let resourceText='';sample.stdout.on('data',chunk=>resourceText+=String(chunk));await new Promise<void>((resolve,reject)=>sample.once('exit',code=>code===0?resolve():reject(Error('Idle sample failed'))))
  const result={draws:f.frameTimes().length-frames,resourceText}
  writeFileSync('/Users/mymac/projects/ade/previews/gpuix/round8/scroll/idle.json',JSON.stringify(result,null,2));console.log(result)
 }finally{await f.close()}
}finally{fixture.close();release()}
