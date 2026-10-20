import {requireScreen,screenState} from './screen-state.ts'
import {execFileSync,spawnSync} from 'node:child_process'
import {watchBuilds} from './build-overlap.ts'

/** Keep the exact required pgrep inventory, then use ancestry to distinguish
 * this runner's children from another lane or an orphan of a cancelled run. */
export function processInventory(owner=process.pid){
 const inventory=spawnSync('pgrep',['-fl','bun .*ade-gpuix'],{encoding:'utf8'})
 if(inventory.status!==0&&inventory.status!==1)throw Error('Unable to inventory GPUIX processes')
 const parents=new Map(execFileSync('ps',['-Ao','pid=,ppid='],{encoding:'utf8'}).trim().split('\n').map(line=>{const [pid,parent]=line.trim().split(/\s+/).map(Number);return [pid!,parent!] as const}))
 const processes=(inventory.stdout??'').trim().split('\n').filter(Boolean)
 // pgrep's path query misses `bun src/main.tsx` launched from an app cwd.
 // Resolve only likely relative GPUIX windows so a foreign orphan cannot
 // silently invalidate an otherwise quiet measurement.
 const relative=execFileSync('ps',['-Ao','pid=,command='],{encoding:'utf8'}).split('\n')
 for(const line of relative){
  const match=line.trim().match(/^(\d+)\s+((?:\/\S*\/)?bun\s+(?:src\/main\.tsx|perf\/bench\/app\.ts)(?:\s.*)?)$/)
  if(!match||processes.some(p=>p.startsWith(`${match[1]} `)))continue
  let cwd=''
  try{cwd=execFileSync('lsof',['-a','-p',match[1]!,'-d','cwd','-Fn'],{encoding:'utf8'}).split('\n').find(p=>p.startsWith('n'))?.slice(1)??''}catch{continue}
  if(/\/apps\/gpuix$/.test(cwd))processes.push(`${match[1]} ${match[2]} [cwd=${cwd}]`)
 }
 const proxyExemptions:string[]=[]
 for(let i=0;i<processes.length;i++){
  const line=processes[i]!,match=line.match(/^(\d+)\s+((?:\/\S*\/)?bun\s+.*\/visual\/fixture\.[^/\s]+\.ts\s+--proxy(?:\s|$).*)$/)
  if(!match)continue
  const sample=spawnSync('ps',['-p',match[1]!,'-o','%cpu='],{encoding:'utf8'}),cpu=Number(sample.stdout.trim())
  const windows=spawnSync('swift',['/Users/mymac/projects/ade-gpuix-scratch/window-onscreen.swift',match[1]!],{encoding:'utf8'})
  if(sample.status===0&&sample.stdout.trim()&&fixtureProxyExempt(match[2]!,cpu,windows.status===0?windows.stdout:null)){
   proxyExemptions.push(line)
   processes[i]=`${line} [http-proxy, windowless cpu=${cpu}%]`
  }
 }
 const foreign=foreignProcesses(processes.filter(line=>!line.includes('[http-proxy, windowless cpu=')),parents,owner)
 return {processes,foreign,proxyExemptions}
}

// Recheck the exemption independently at both endpoints; gaining a window
// or reaching 1% CPU restores foreign-process rejection.
export function watchRun(){
 const screenBefore=requireScreen(),startedAt=new Date().toISOString(),before=processInventory(),builds=watchBuilds()
 return {finish(){const screenAfter=screenState(),after=processInventory();return {screenBefore,screenAfter,screenInvalid:!screenAfter.valid,...builds.finish(),timedWindowStartedAt:startedAt,timedWindowEndedAt:new Date().toISOString(),gpuixProcessesBefore:before.processes,gpuixProcessesAfter:after.processes,foreignProcessesBefore:before.foreign,foreignProcessesAfter:after.foreign,orphanOverlap:before.foreign.length>0||after.foreign.length>0}}}
}

export function foreignProcesses(processes:string[],parents:Map<number,number>,owner:number){
 const owned=(pid:number)=>{const seen=new Set<number>();while(pid>1&&!seen.has(pid)){if(pid===owner)return true;seen.add(pid);pid=parents.get(pid)??0}return false}
 // Runners and resource samplers do not own a native window.
 return processes.filter(line=>{const match=line.match(/^(\d+)\s+(.+)$/);return !!match&&!owned(Number(match[1]))&&!/\/(?:run|scenario|sample|profiles|structural|ui-lease|quiet)\.(?:ts|mjs)(?:\s|$)/.test(match[2]!)&&/^(?:\/\S*\/)?bun\s+/.test(match[2]!)})
}

/** A fixture name alone is insufficient: preserve active or visible helpers. */
export function fixtureProxyExempt(command:string,cpu:number,windows:string|null){
 return /^(?:\/\S*\/)?bun\s+.*\/visual\/fixture\.[^/\s]+\.ts\s+--proxy(?:\s|$)/.test(command)&&Number.isFinite(cpu)&&cpu>=0&&cpu<1&&windows!==null&&windows.trim()===''
}
