import { existsSync, readFileSync, writeFileSync } from 'node:fs'
const out = '/Users/mymac/projects/ade/previews/gpuix/perf/sidebar'
const read = (name: string) => JSON.parse(readFileSync(`${out}/${name}`, 'utf8'))
const mean = (v: number[]) => v.length ? v.reduce((a,b)=>a+b,0)/v.length : null
const pct = (v: number[], p: number) => [...v].sort((a,b)=>a-b)[Math.min(v.length-1,Math.floor(v.length*p))] ?? null
const resources = (text: string) => {
  const match = text.match(/total\s+([\d.]+) MiB\s+cpu\s+([\d.]+)%\s+gpu\s+([\d.]+) ms/)
  if (!match) throw Error(`Resource summary missing: ${text}`)
  return { footprintMiB: Number(match[1]), cpuPercent: Number(match[2]), gpuMs: Number(match[3]) }
}
function summarize(names: string[]) {
  const runs = names.filter(name=>existsSync(`${out}/${name}`)).map(name=>({file:name,...read(name).results[0]}))
  if(!runs.length)return null
  const intervals = runs.flatMap(r=>r.intervals as number[]), work = runs.flatMap(r=>r.costs as {render:number;layout:number}[])
  const resource = runs.map(r=>resources(r.resourceText))
  return { files:runs.map(r=>r.file), samples:runs.length, fullRate:1,
    frames:runs.reduce((n,r)=>n+r.frames,0), frameP50:pct(intervals,.5),frameP95:pct(intervals,.95),frameP99:pct(intervals,.99),
    over16_7:intervals.filter(n=>n>16.7).length,over33:intervals.filter(n=>n>33).length,maxFrameMs:Math.max(0,...intervals),
    renderP95:pct(work.map(c=>c.render),.95),layoutP95:pct(work.map(c=>c.layout),.95),
    cpuPercent:mean(resource.map(r=>r.cpuPercent)),cpuSamples:resource.map(r=>r.cpuPercent),
    gpuMsPer15s:mean(resource.map(r=>r.gpuMs)),gpuSamples:resource.map(r=>r.gpuMs),
    footprintMiB:mean(resource.map(r=>r.footprintMiB)),footprintSamples:resource.map(r=>r.footprintMiB),
    offeredToHandlerP95Samples:runs.map(r=>r.offeredToAppKitHandlerEndP95),inputToCpuPaintP95Samples:runs.map(r=>r.inputToCpuPaintP95),
    deliveredAtOfferEndSamples:runs.map(r=>r.deliveredAtOfferEnd), offered:runs.map(r=>r.offeredPackets),
    processGuards:runs.map(r=>({before:r.processesBefore,after:r.processesAfter})),
    buildGuards:runs.map(r=>({before:r.nativeBuildMarkersBefore,during:r.nativeBuildMarkersDuring,after:r.nativeBuildMarkersAfter})) }
}
const scroll: Record<string,unknown> = {}
for (const scene of ['settled','running','mixed']) for(const variant of ['baseline','p1','candidate']) scroll[`${scene}/${variant}`]=summarize([0,1].map(i=>`${variant}-final-${scene}-${i}-dark.json`))
for (const scene of ['fast','idle','profile']) for(const variant of ['baseline',...(scene==='fast'?['p1']:[]),'candidate']) scroll[`${scene}/${variant}`]=summarize([`${variant}-final-${scene}-dark.json`])
scroll['wide-overdraw/candidate']=summarize(['candidate-final-wide-overdraw-dark.json'])
scroll['idle-settled/candidate']=summarize(['candidate-final-idle-settled-dark.json'])
for (const buffer of ['1536','3072']) scroll[`buffer-${buffer}/candidate-fast`]=summarize([`candidate-buffer-${buffer}-fast-dark.json`])
const cold: Record<string,unknown> = {}
for (const variant of ['baseline','candidate']) for(const temperature of ['cold','warm']) {
  const runs = [0,1,2].flatMap(i=>{
    const file=`cold-final-${variant}-${i}.json`
    return existsSync(`${out}/${file}`)?[{file,...read(file)[temperature==='cold'?0:1]}]:[]
  })
  cold[`${temperature}/${variant}`]={samples:runs.length,fullRate:1,sidebarMedianMs:pct(runs.map(r=>r.sidebar),.5),sidebarSamples:runs.map(r=>r.sidebar),contentMedianMs:pct(runs.map(r=>r.content),.5),contentSamples:runs.map(r=>r.content),shellMedianMs:pct(runs.map(r=>r.shell),.5),
    listsReadySamples:runs.map(r=>r.timeline.find((m:{phase:string})=>m.phase==='lists-ready')?.ms),
    sidebarAfterListsSamples:runs.map(r=>r.sidebar-(r.timeline.find((m:{phase:string})=>m.phase==='lists-ready')?.ms??0)),
    bodiesCommitted:runs.map(r=>r.timeline.find((m:{phase:string})=>m.phase==='sidebar-bodies-committed')),
    files:runs.map(r=>r.file)}
}
const summary={note:'Only fresh *-final-* files. Profile rows are diagnostic and excluded from clean acceptance claims. Submission intervals are pooled; resources are per-15-second sample means with individual samples retained; latency columns retain each run p95.',scroll,cold}
writeFileSync(`${out}/summary.json`,JSON.stringify(summary,null,2))
console.log(JSON.stringify(summary,null,2))
