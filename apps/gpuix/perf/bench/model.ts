export const SCENARIOS = ['startup-cold','startup-warm','startup-packaged','open-long','older-history','thread-scroll','thread-fling','sidebar-scroll','explorer-scroll','markdown-scroll','code-scroll','pr-summary','pr-changes','streaming','idle-home','idle-thread'] as const
export type Scenario = typeof SCENARIOS[number]
export const percentile = (values: number[], fraction: number): number | null => { const sorted=[...values].sort((a,b)=>a-b); return sorted[Math.min(sorted.length-1,Math.floor(sorted.length*fraction))]??null }
export const distribution = (values: number[]) => ({p50:percentile(values,.5),p95:percentile(values,.95),p99:percentile(values,.99),max:values.length?Math.max(...values):null})
export type Result = {
 scenario: Scenario; run: number; host: string; status: 'ok'|'failed'|'skipped'|'discarded'; reason?: string; fullRate: string;
 frames: ReturnType<typeof distribution> & {count:number;over16_7:number;over33:number};
 latency: {kind:string;inputToPresentMs:null;proxyMs:ReturnType<typeof distribution>;samples:number};
 resources: {cpuPercent:number|null;gpuMs:number|null;footprintMiB:number|null;sampleSeconds:number|null};
 timings: Record<string, number|null>; work: {reactCommits:number;renderMs:ReturnType<typeof distribution>;layoutMs:ReturnType<typeof distribution>};
 evidence: Record<string,unknown>
}
export function emptyResult(scenario:Scenario,run:number):Result {return {scenario,run,host:'GPUIX development (bun src/main.tsx via pacing instrumentation)',status:'ok',fullRate:process.env.KYBERN_FULL_RATE??'1',frames:{...distribution([]),count:0,over16_7:0,over33:0},latency:{kind:'offered native RPC to next scene-submission stderr receipt; not a physical presentation fence',inputToPresentMs:null,proxyMs:distribution([]),samples:0},resources:{cpuPercent:null,gpuMs:null,footprintMiB:null,sampleSeconds:null},timings:{},work:{reactCommits:0,renderMs:distribution([]),layoutMs:distribution([])},evidence:{}}}
export const fmt = (n:number|null|undefined) => n==null?'—':n.toFixed(2)
export function table(results:Result[]) {
 const rows=SCENARIOS.flatMap(scenario=>{const group=results.filter(r=>r.scenario===scenario),ok=group.filter(r=>r.status==='ok');if(!group.length)return[];const med=(f:(r:Result)=>number|null)=>percentile(ok.flatMap(r=>f(r)==null?[]:[f(r)!]),.5);return [`| ${scenario} | ${ok.length}/${group.length} | ${fmt(med(r=>r.frames.p50))} / ${fmt(med(r=>r.frames.p95))} / ${fmt(med(r=>r.frames.p99))} | ${fmt(med(r=>r.frames.over16_7))} / ${fmt(med(r=>r.frames.over33))} | ${fmt(med(r=>r.frames.max))} | ${fmt(med(r=>r.latency.proxyMs.p95))} | ${fmt(med(r=>r.resources.cpuPercent))} | ${fmt(med(r=>r.resources.gpuMs))} | ${fmt(med(r=>r.resources.footprintMiB))} | ${group.find(r=>r.reason)?.reason??''} |`]})
 return ['| Scenario | OK/runs | Frame p50/p95/p99 ms | >16.7/>33 | Max gap ms | Latency proxy p95 ms | CPU % | GPU ms/window | MiB | Notes |','|---|---:|---|---|---:|---:|---:|---:|---:|---|',...rows,'',...startupTable(results)].join('\n')
}

function startupTable(results:Result[]){
 const rows=SCENARIOS.filter(s=>s.startsWith('startup-')).flatMap(s=>{
  const ok=results.filter(r=>r.scenario===s&&r.status==='ok')
  return ok.length?[`| ${s} | ${['firstPaintedShellMs','sidebarPaintMs','firstContentMs','newestContentMs'].map(key=>{const values=ok.flatMap(r=>r.timings[key]==null?[]:[r.timings[key]!]);return `${fmt(percentile(values,.5))} / ${fmt(percentile(values,.9))}`}).join(' | ')} |`]:[]
 })
 return rows.length?['| Startup | Shell median/p90 ms | Sidebar median/p90 ms | First content median/p90 ms | Newest content median/p90 ms |','|---|---:|---:|---:|---:|',...rows]:[]
}
