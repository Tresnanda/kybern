import {execFileSync,spawnSync} from 'node:child_process'
import {watchBuilds} from './build-overlap.ts'

/** Keep the exact required pgrep inventory, then use ancestry to distinguish
 * this runner's children from another lane or an orphan of a cancelled run. */
export function processInventory(owner=process.pid){
 const inventory=spawnSync('pgrep',['-fl','bun .*ade-gpuix'],{encoding:'utf8'})
 if(inventory.status!==0&&inventory.status!==1)throw Error('Unable to inventory GPUIX processes')
 const parents=new Map(execFileSync('ps',['-Ao','pid=,ppid='],{encoding:'utf8'}).trim().split('\n').map(line=>{const [pid,parent]=line.trim().split(/\s+/).map(Number);return [pid!,parent!] as const}))
 const processes=(inventory.stdout??'').trim().split('\n').filter(Boolean)
 const foreign=foreignProcesses(processes,parents,owner)
 return {processes,foreign}
}

export function watchRun(){
 const before=processInventory(),builds=watchBuilds()
 return {finish(){const after=processInventory();return {...builds.finish(),gpuixProcessesBefore:before.processes,gpuixProcessesAfter:after.processes,foreignProcessesBefore:before.foreign,foreignProcessesAfter:after.foreign,orphanOverlap:before.foreign.length>0||after.foreign.length>0}}}
}

export function foreignProcesses(processes:string[],parents:Map<number,number>,owner:number){
 const owned=(pid:number)=>{const seen=new Set<number>();while(pid>1&&!seen.has(pid)){if(pid===owner)return true;seen.add(pid);pid=parents.get(pid)??0}return false}
 // Runners and resource samplers do not own a native window.
 return processes.filter(line=>{const match=line.match(/^(\d+)\s+(.+)$/);return !!match&&!owned(Number(match[1]))&&!/\/(?:run|scenario|sample|profiles|structural)\.(?:ts|mjs)(?:\s|$)/.test(match[2]!)&&/^(?:\/\S*\/)?bun\s+/.test(match[2]!)})
}
