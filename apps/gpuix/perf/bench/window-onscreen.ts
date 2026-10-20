import {execFileSync} from 'node:child_process'

const script=`${import.meta.dir}/window-onscreen.swift`

export function windowOnscreen(pid:number){
 return parseWindowOnscreen(execFileSync('swift',[script,String(pid)],{encoding:'utf8'}))
}

export function parseWindowOnscreen(raw:string){
 const field=(bounds:string,name:string)=>Number(bounds.match(new RegExp(`\\b${name}\\s*=\\s*"?(-?[\\d.]+)"?`))?.[1])
 const header=raw.match(/test-display\s+(\d+)\s+scale=([\d.]+)\s+bounds=\{([^}]*)\}/)
 const display=header?{id:Number(header[1]),scale:Number(header[2]),x:field(header[3]!,'X'),y:field(header[3]!,'Y'),width:field(header[3]!,'Width'),height:field(header[3]!,'Height')}:null
 const windows=[...raw.matchAll(/window\s+\d+\s+onscreen=(true|false)\s+scale=([\d.]+)\s+bounds=\{([^}]*)\}/g)].map(match=>{
  return {scale:Number(match[2]),onscreen:match[1]==='true',x:field(match[3]!,'X'),y:field(match[3]!,'Y'),width:field(match[3]!,'Width'),height:field(match[3]!,'Height')}
 })
 // Closing the lid makes the hidden display primary at (0,0). Its pinned
 // display id, actual CG bounds and scale identify it in either topology.
 const valid=!!display&&display.id>0&&display.scale===2&&display.width>0&&display.height>0&&windows.some(w=>w.onscreen&&w.scale===2&&w.x>=display.x&&w.y>=display.y&&w.width>0&&w.height>0&&w.x+w.width<=display.x+display.width&&w.y+w.height<=display.y+display.height)
 return {valid,display,windows,raw}
}

export function requireWindowOnscreen(pid:number){
 const state=windowOnscreen(pid)
 if(!state.valid)throw Error(`GPUIX window ${pid} is not onscreen on the hidden test display at 2x: ${state.raw}`)
 return state
}

export async function waitForWindowOnscreen(pid:number,maxWaitMs=180_000){
 const end=performance.now()+maxWaitMs
 for(;;){
  const state=windowOnscreen(pid)
  if(state.valid)return state
  if(performance.now()>=end)throw Error(`GPUIX window ${pid} stayed offscreen on the hidden test display at 2x: ${state.raw}`)
  await Bun.sleep(10_000)
 }
}
