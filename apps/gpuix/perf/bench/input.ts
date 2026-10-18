import type {launchFixture} from '../../src/requests/harness.ts'
export type App = Awaited<ReturnType<typeof launchFixture>>['app']
export type Point={x:number;y:number}
// Same pipelined schedule as perf/scroll8.ts: precise contact/ramp, synthetic
// exponential momentum, direction reversal. No per-packet geometry queries.
export async function drive(app:App,point:Point,milliseconds:number,fling=false){
 const sent:number[]=[],acks:number[]=[],pending:Promise<unknown>[]=[],active=new Set<Promise<unknown>>()
 const start=performance.now(),count=Math.floor(milliseconds*120/1000)
 let outstanding=0,maxOutstanding=0
 for(let i=0;i<count&&performance.now()-start<milliseconds;i++){
  if(active.size>=8)await Promise.race(active)
  if(performance.now()-start>=milliseconds)break
  const phase=i%300,cycle=i%600,direction=cycle<300?-1:1
  const delta=fling?(phase<20?45:45*Math.exp(-(phase-20)/35)):(phase<120?6*Math.sin(Math.PI*Math.min(phase+1,30)/60):6*Math.exp(-(phase-120)/45))
  const touchPhase=phase===0||phase===120?'started':phase===119||phase===299?'ended':'moved'
  const at=performance.now();sent.push(at);outstanding++;maxOutstanding=Math.max(maxOutstanding,outstanding)
  const packet=app.call('scrollWheel',{...point,deltaX:0,deltaY:direction*delta,phase:touchPhase}).then(()=>{acks.push(performance.now()-at);outstanding--}).finally(()=>active.delete(packet))
  active.add(packet);pending.push(packet)
  const due=start+(i+1)*1000/120;if(due>performance.now())await Bun.sleep(due-performance.now())
 }
 const productionMs=performance.now()-start
 await Promise.all(pending)
 return {sent,acks,maxOutstanding,productionMs,drainMs:performance.now()-start-productionMs,input:'120 Hz scheduled native GPUI wheel RPC, at most 8 outstanding; real-time window truncates unoffered packets under backpressure; phase markers + synthetic exponential momentum'}
}
