import {execFileSync} from 'node:child_process'

const script='/Users/mymac/projects/ade-gpuix-scratch/window-onscreen.swift'

export function windowOnscreen(pid:number){
 const raw=execFileSync('swift',[script,String(pid)],{encoding:'utf8'})
 const windows=[...raw.matchAll(/window\s+\d+\s+onscreen=(true|false)\s+bounds=\{([^}]*)\}/g)].map(match=>{
  const field=(name:string)=>Number(match[2]!.match(new RegExp(`\\b${name}\\s*=\\s*(-?[\\d.]+)`))?.[1])
  return {onscreen:match[1]==='true',x:field('X'),y:field('Y'),width:field('Width'),height:field('Height')}
 })
 const valid=windows.some(w=>w.onscreen&&w.x>=0&&w.y>=0&&w.width>0&&w.height>0&&w.x+w.width<=1440&&w.y+w.height<=900)
 return {valid,windows,raw}
}

export function requireWindowOnscreen(pid:number){
 const state=windowOnscreen(pid)
 if(!state.valid)throw Error(`GPUIX window ${pid} is not onscreen on the built-in display: ${state.raw}`)
 return state
}

export async function waitForWindowOnscreen(pid:number,maxWaitMs=180_000){
 const end=performance.now()+maxWaitMs
 for(;;){
  const state=windowOnscreen(pid)
  if(state.valid)return state
  if(performance.now()>=end)throw Error(`GPUIX window ${pid} stayed offscreen on the built-in display: ${state.raw}`)
  await Bun.sleep(10_000)
 }
}
