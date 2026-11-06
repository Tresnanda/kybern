import {writeFileSync} from 'node:fs'
import {firstPageParams} from '../../src/transcript/openFlow.ts'
import {freshCopy, readFixture, startDaemon} from './scratch.ts'
import {meteredClient, median, p95, linkProxy} from './meter.ts'
const fixture=readFixture(), samples:any[]=[]
for(const rtt of [0,40]) for(let run=0;run<10;run++) {
 const daemon=await startDaemon(process.argv[2]!,freshCopy('part2'),4421)
 const proxy=rtt?linkProxy(4422,daemon.url,rtt,20):undefined
 const {client,meter}=await meteredClient(proxy?.url??daemon.url,daemon.token)
 try {
  const get=(id:string)=>client.call('threads.get',firstPageParams(id))
  for(const role of ['long','medium','short'] as const) for(const cache of ['cold','warm']) {
   const mark=meter.mark();const page=await get(fixture[role]);
   samples.push({case:`${role}-${cache}`,rtt,run,...meter.span(mark),rows:page.transcript.length})
  }
  for(const mode of ['parallel','serial']) {
   const mark=meter.mark()
   const list=()=>client.call('threads.list',{settled_limit:25})
   if(mode==='parallel') await Promise.all([list(),get(fixture.short)])
   else {await list();await get(fixture.short)}
   samples.push({case:`list-head-${mode}`,rtt,run,...meter.span(mark)})
  }
 } finally {client.close();proxy?.stop();await daemon.stop()}
}
const summary:any[]=[]
for(const rtt of [0,40]) for(const name of [...new Set(samples.map(x=>x.case))]) {
 const xs=samples.filter(x=>x.rtt===rtt&&x.case===name)
 summary.push({case:name,rtt,n:xs.length,medianMs:median(xs.map(x=>x.ms)),p95Ms:p95(xs.map(x=>x.ms)),bytes:median(xs.map(x=>x.bytes)),roundTrips:median(xs.map(x=>x.roundTrips))})
}
writeFileSync('apps/gpuix/perf/instant-load-2026-11/results/part-2-reads.json',JSON.stringify({boundary:'RPC send to parsed response; no rendering; fresh daemon per run; cold OS file cache not controlled',summary,samples},null,2))
console.table(summary)
