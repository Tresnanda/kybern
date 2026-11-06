import {writeFileSync} from 'node:fs'
import {applyEvent,emptyThreadState} from '../../../../packages/kybern-client/src/transcript.ts'
import {median,p95} from './meter.ts'
const samples:any[]=[]
// An explicit sensitivity model, not a captured provider or network trace.
for(const hz of [20,50,100,200]) for(const batch of new Set([1,Math.max(1,Math.floor(hz*.05))])) {
 const count=hz*10, payload='A short delta. ', events=Array.from({length:count},(_,i)=>({seq:i+1,thread_id:'00000000-0000-0000-0000-000000000001',turn_id:'00000000-0000-0000-0000-000000000002',at:'2026-11-07T00:00:00Z',kind:'assistant_text_delta',message_id:'00000000-0000-0000-0000-000000000003',origin:{kind:'root'},delta:payload}))
 const grouped=Array.from({length:Math.ceil(count/batch)},(_,i)=>({...events[Math.min(count-1,(i+1)*batch-1)],delta:payload.repeat(Math.min(batch,count-i*batch))}))
 const wires=grouped.map(event=>JSON.stringify({jsonrpc:'2.0',method:'event',params:{subscription_id:'00000000-0000-0000-0000-000000000004',event}}))
 for(let run=0;run<31;run++) {
  let state=emptyThreadState(); const cpu=process.cpuUsage(),start=performance.now()
  for(const wire of wires) state=applyEvent(state,JSON.parse(wire).params.event)
  const ms=performance.now()-start,cost=process.cpuUsage(cpu)
  const assistant=state.blocks.find(b=>b.kind==='assistant')
  if(assistant?.kind!=='assistant'||assistant.text!==payload.repeat(count)||state.lastSeq!==count) throw Error('text/cursor changed')
  if(run) samples.push({hz,batch,run,ms,cpuMs:(cost.user+cost.system)/1000,messagesPerSecond:wires.length/10,bytesPerSecond:wires.reduce((n,s)=>n+Buffer.byteLength(s),0)/10})
 }
}
const summary=[]
for(const key of [...new Set(samples.map(s=>`${s.hz}/${s.batch}`))]) {
 const xs=samples.filter(s=>`${s.hz}/${s.batch}`===key),s=xs[0]
 summary.push({hz:s.hz,batch:s.batch,n:xs.length,messagesPerSecond:s.messagesPerSecond,bytesPerSecond:s.bytesPerSecond,medianApplyMsPerTenSeconds:median(xs.map(s=>s.ms)),p95ApplyMsPerTenSeconds:p95(xs.map(s=>s.ms)),medianCpuMsPerTenSeconds:median(xs.map(s=>s.cpuMs))})
}
writeFileSync('apps/gpuix/perf/instant-load-2026-11/results/part-2-stream-model.json',JSON.stringify({boundary:'synthetic sensitivity model, 10 seconds of input applied in a synchronous burst; no socket, relay, real Tailscale, UI, timers or paced streaming',summary,samples},null,2));console.table(summary)
