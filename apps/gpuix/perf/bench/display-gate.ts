import {execFileSync} from 'node:child_process'
/** Never unlock the session or change global power settings. */
export function assertDisplayReady(){
 const state=execFileSync('swift',['/Users/mymac/projects/ade-gpuix-scratch/screen-state.swift'],{encoding:'utf8'}).trim()
 if(!/locked:\s+0\b/.test(state)||!/displayAsleep:\s+(?:0|false)\b/.test(state))throw Error(`Discard/pause UI measurement: ${state}`)
 return state
}
