import { distribution } from './model.ts'
export class Telemetry {
 private remainder=''
 submissions:{native:number;received:number}[]=[]
 costs:{render:number;layout:number}[]=[]
 inputPaints:{packets:number;first:number;last:number}[]=[]
 commits=0
 raw=''
 stderr=(chunk:string)=>{
  this.raw=(this.raw+chunk).slice(-2_000_000)
  const lines=(this.remainder+chunk).split('\n');this.remainder=lines.pop()??''
  for(const line of lines){
   const submit=line.match(/\[kybern-submit\] ([\d.]+)/);if(submit)this.submissions.push({native:Number(submit[1]),received:performance.now()})
   const cost=line.match(/\[kybern-work\] renderMs=([\d.]+) layoutMs=([\d.]+)/);if(cost)this.costs.push({render:Number(cost[1]),layout:Number(cost[2])})
   const paint=line.match(/\[scroll-input-paint\] packets=(\d+) firstMs=([\d.]+) lastMs=([\d.]+)/)
   if(paint)this.inputPaints.push({packets:Number(paint[1]),first:Number(paint[2]),last:Number(paint[3])})
   if(line.includes('[pacing-commit]'))this.commits++
  }
 }
 mark(){return {frames:this.submissions.length,costs:this.costs.length,commits:this.commits,paints:this.inputPaints.length}}
 result(mark:{frames:number;costs:number;commits:number;paints?:number},sent:number[]=[],includeBoundaryInterval=false){
  const frames=this.submissions.slice(mark.frames),intervals=frames.slice(1).map((v,i)=>v.native-frames[i]!.native)
  // A continuous scroll can stall before its first measured submission. Keep
  // the gap from the warmup's last scene instead of reporting only the smooth
  // tail after that stall. Idle and one-off scenarios have no continuous frame
  // expectation, so their preceding gap is not a missed animation interval.
  if(includeBoundaryInterval&&frames.length&&mark.frames>0)intervals.unshift(frames[0]!.native-this.submissions[mark.frames-1]!.native)
  const latency=sent.flatMap(at=>{const next=frames.find(f=>f.received>=at);return next?[next.received-at]:[]})
  const costs=this.costs.slice(mark.costs),paints=this.inputPaints.slice(mark.paints??0)
  return {frames:{...distribution(intervals),count:frames.length,over16_7:intervals.filter(v=>v>16.7).length,over33:intervals.filter(v=>v>33).length},proxy:distribution(latency),latencySamples:latency.length,nativeInput:{samples:paints.length,packets:paints.reduce((n,p)=>n+p.packets,0),firstMs:distribution(paints.map(p=>p.first)),lastMs:distribution(paints.map(p=>p.last)),meaning:"GPUI dispatch to CPU scene construction; excludes OS and host queue, GPU and physical presentation"},work:{reactCommits:this.commits-mark.commits,renderMs:distribution(costs.map(c=>c.render)),layoutMs:distribution(costs.map(c=>c.layout))}}
 }
}
export function parseResources(raw:string){
 const match=raw.match(/total\s+([\d.]+) MiB\s+cpu\s+([\d.]+)%\s+gpu\s+([\d.-]+) ms over ([\d.]+)s/)
 if(!match)throw Error(`Resource sampler failed: ${raw}`)
 const windowServer=parseGroup(raw,'WindowServer')
 return {footprintMiB:Number(match[1]),cpuPercent:Number(match[2]),gpuMs:Number(match[3]),sampleSeconds:Number(match[4]),...(windowServer?{windowServer}:{})}
}
/** One named group's `total` line (`sample.ts` prints a blank line, the group name, its pids, then the total). Footprint is NaN for root-owned processes, so only CPU and GPU are read. */
export function parseGroup(raw:string,name:string){
 const start=raw.split('\n').findIndex(line=>line.trim()===name)
 if(start<0)return null
 const lines=raw.split('\n').slice(start+1),end=lines.findIndex((line,i)=>i>0&&/^\S/.test(line))
 const match=(end<0?lines:lines.slice(0,end)).join('\n').match(/total\s+\S+ MiB\s+cpu\s+([\d.]+)%\s+gpu\s+([\d.-]+) ms/)
 return match?{cpuPercent:Number(match[1]),gpuMs:Number(match[2])}:null
}
/** `getBridgeStats()` from the native addon (WP1): commands sent to GPUI's UI thread, the ones that waited, and frames. */
export type BridgeStats={bridged:boolean;sent:number;waited:number;waitMs:number;servedFrames:number|null;drawnFrames?:number|null;callbackFrames?:number|null;frameWakes:number;platform:string}
/** Bridge traffic over one timed window. Off macOS, per-frame values divide by the window's served frames (frames that drew
 * or only ran next-frame callbacks, split as `drawnFrames`/`callbackFrames` when the addon reports them); a regression shows
 * as more `waitedPerFrame`. macOS runs hooks on the JS thread (`bridged: false`): only its frame wakes are counted. Null
 * when the addon predates the counters. */
export function bridgeDelta(before:BridgeStats|null,after:BridgeStats|null){
 if(!before||!after)return null
 const frames=before.servedFrames!=null&&after.servedFrames!=null?after.servedFrames-before.servedFrames:null
 const perFrame=(value:number)=>frames?value/frames:null
 const sent=after.sent-before.sent,waited=after.waited-before.waited,waitMs=after.waitMs-before.waitMs
 const split=(key:'drawnFrames'|'callbackFrames')=>before[key]!=null&&after[key]!=null?after[key]!-before[key]!:null
 return {platform:after.platform,bridged:after.bridged,servedFrames:frames,drawnFrames:split('drawnFrames'),callbackFrames:split('callbackFrames'),frameWakes:after.frameWakes-before.frameWakes,sent,waited,waitMs,sentPerFrame:perFrame(sent),waitedPerFrame:perFrame(waited),waitMsPerFrame:perFrame(waitMs)}
}
