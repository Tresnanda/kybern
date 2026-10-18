import { distribution } from './model.ts'
export class Telemetry {
 private remainder=''
 submissions:{native:number;received:number}[]=[]
 costs:{render:number;layout:number}[]=[]
 commits=0
 raw=''
 stderr=(chunk:string)=>{
  this.raw=(this.raw+chunk).slice(-2_000_000)
  const lines=(this.remainder+chunk).split('\n');this.remainder=lines.pop()??''
  for(const line of lines){
   const submit=line.match(/\[kybern-submit\] ([\d.]+)/);if(submit)this.submissions.push({native:Number(submit[1]),received:performance.now()})
   const cost=line.match(/\[kybern-work\] renderMs=([\d.]+) layoutMs=([\d.]+)/);if(cost)this.costs.push({render:Number(cost[1]),layout:Number(cost[2])})
   if(line.includes('[pacing-commit]'))this.commits++
  }
 }
 mark(){return {frames:this.submissions.length,costs:this.costs.length,commits:this.commits}}
 result(mark:ReturnType<Telemetry['mark']>,sent:number[]=[]){
  const frames=this.submissions.slice(mark.frames),intervals=frames.slice(1).map((v,i)=>v.native-frames[i]!.native)
  const latency=sent.flatMap(at=>{const next=frames.find(f=>f.received>=at);return next?[next.received-at]:[]})
  const costs=this.costs.slice(mark.costs)
  return {frames:{...distribution(intervals),count:frames.length,over16_7:intervals.filter(v=>v>16.7).length,over33:intervals.filter(v=>v>33).length},proxy:distribution(latency),latencySamples:latency.length,work:{reactCommits:this.commits-mark.commits,renderMs:distribution(costs.map(c=>c.render)),layoutMs:distribution(costs.map(c=>c.layout))}}
 }
}
export function parseResources(raw:string){
 const match=raw.match(/total\s+([\d.]+) MiB\s+cpu\s+([\d.]+)%\s+gpu\s+([\d.-]+) ms over ([\d.]+)s/)
 if(!match)throw Error(`Resource sampler failed: ${raw}`)
 return {footprintMiB:Number(match[1]),cpuPercent:Number(match[2]),gpuMs:Number(match[3]),sampleSeconds:Number(match[4])}
}
