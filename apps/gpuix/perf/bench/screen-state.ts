import {execFileSync,spawn} from 'node:child_process'
import {existsSync} from 'node:fs'
import {onExit} from './lifetime.ts'
const shared='/Users/mymac/projects/ade-gpuix-scratch/screen-state.swift'
/** With a phase (lane wrappers), an unusable screen throws instead of returning an invalid state. */
export function screenState(phase?:string){
 const script=process.env.KYBERN_BENCH_SCREEN_STATE_SCRIPT??(existsSync(shared)?shared:`${import.meta.dir}/screen-state.swift`)
 const state={phase,...parseScreenState(execFileSync('swift',[script],{encoding:'utf8'}))}
 if(phase&&!state.valid)throw Error(`Screen gate (${phase}): discard/pause while locked or asleep: ${state.raw}`)
 return state
}
export function parseScreenState(raw:string){
 const unlocked=/locked:\s*(?:0|false)\b/.test(raw),awake=/displayAsleep:\s*(?:0|false)\b/.test(raw)
 return {at:new Date().toISOString(),unlocked,awake,valid:unlocked&&awake,raw:raw.trim()}
}
export function requireScreen(){const state=screenState();if(!state.valid)throw Error(`Screen unavailable; discard run and wait: ${state.raw}`);return state}
export async function waitForScreen(){while(!screenState().valid)await Bun.sleep(60000)}
/** Lifetime is tied to the runner even if it is killed without cleanup. */
export function keepDisplayAwake(){
 const child=spawn('caffeinate',['-d','-w',String(process.pid)],{stdio:'ignore'})
 child.on('error',error=>{throw error})
 const stop=()=>{child.kill();unregister()};const unregister=onExit(stop)
 return stop
}
export function requireActiveSample(frames:number,gpuMs:number|null,seconds:number){
 if(frames<Math.max(2,seconds/4)||!(gpuMs!=null&&gpuMs>0))throw Error(`Invalid active sample: ${frames} submissions, ${gpuMs} GPU ms in ${seconds}s; discard and repeat unlocked`)
}
