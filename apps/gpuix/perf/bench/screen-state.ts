import {spawnSync} from 'node:child_process'
// Opt in from a lane wrapper; ordinary benchmark callers stay portable.
export function screenState(phase:string){
 const script=process.env.KYBERN_BENCH_SCREEN_STATE_SCRIPT
 if(!script)return null
 const result=spawnSync('swift',[script],{encoding:'utf8'})
 const raw=result.stdout?.trim()??''
 const unlocked=/locked:\s*(?:0|nil)\b/.test(raw),awake=/displayAsleep:\s*(?:0|false)\b/.test(raw)
 if(result.status!==0||!unlocked||!awake)throw Error(`Screen gate (${phase}): discard/pause while locked or asleep: ${raw} ${result.stderr??''}`)
 return {phase,at:new Date().toISOString(),raw,unlocked,awake}
}
