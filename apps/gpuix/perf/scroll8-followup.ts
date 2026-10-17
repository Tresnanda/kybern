// Remaining resource/interaction controls, each under a separate fair UI lease.
import path from 'node:path'
import {pacingLock,waitForNativeBuilds} from './scroll8-lock.ts'
import {appendFileSync,readFileSync,renameSync} from 'node:fs'
const root=path.resolve(import.meta.dir,'../../..'),out='/Users/mymac/projects/ade/previews/gpuix/round8/scroll'
let leased=false
async function run(args:string[],env:Record<string,string>={}){
 const c=Bun.spawn(['bun',...args],{env:{...process.env,GPUIX_BACKGROUND:'1',...(leased?{KYBERN_PACING_PARENT_LEASE:root}:{}),...env},stdout:'pipe',stderr:'pipe'})
 const[stdout,stderr,code]=await Promise.all([new Response(c.stdout).text(),new Response(c.stderr).text(),c.exited]);appendFileSync(`${out}/followup.log`,`${args.join(' ')}\n${stdout}${stderr}\nexit=${code}\n`);process.stdout.write(stdout);process.stderr.write(stderr)
 if(code)throw Error(args.join(' '))
}
async function batch(task:()=>Promise<void>){await waitForNativeBuilds();const release=await pacingLock();leased=true;try{await task()}finally{leased=false;release()}}
if(process.env.SCROLL8_VISUAL_ONLY!=='1'){
// Reject no-paint samples. A background macOS window can lose its display
// source when occluded; a cheap ACK is not proof that scrolling was painted.
for(const theme of ['dark','light'])for(const reduce of ['0','1']){
 const file=`${out}/after-${theme}-${reduce}.json`
 const valid=()=>{const d=JSON.parse(readFileSync(file,'utf8'));return d.results.length===4&&d.results.every((r:any)=>r.frameCount>200&&r.matchedCpuPaintPackets===1800)}
 if(!valid()){
  renameSync(file,`${out}/invalid-no-paint-after-${theme}-${reduce}.json`)
  renameSync(`${out}/after-${theme}-${reduce}.log`,`${out}/invalid-no-paint-after-${theme}-${reduce}.log`)
  await batch(()=>run(['perf/scroll8.ts','after',theme,reduce],{KYBERN_SCROLL_LAYOUT:'1',KYBERN_SCROLL_ISLANDS:'1',KYBERN_SCROLL_COALESCE:'pr',KYBERN_INPUT_FRAME_DRAW:'0'}))
  if(!valid())throw Error(`Repeated no-paint/incomplete ${theme}/${reduce} sample; refuse scroll acceptance`)
 }
}
await batch(async()=>{
 if(process.env.SCROLL8_FOLLOWUP_SKIP_CHECKS!=='1'){
 try{await run(['perf/scroll8-experiment-check.ts'])}catch(error){appendFileSync(`${out}/followup.log`,`Experimental frame drawing failed; keep opt-in. ${String(error)}\n`);console.error('Experimental frame drawing failed; continuing default-path acceptance.')}

 for(const theme of ['dark','light'])for(const reduce of ['0','1']){
  try{await run(['src/pulls/verify.actions.ts',...(theme==='light'?['--light']:[])],{KYBERN_APPEARANCE:theme,KYBERN_REDUCED_MOTION:reduce})}catch(error){appendFileSync(`${out}/followup.log`,`PR action check failed (also reproduced with baseline-round8.node and both caches disabled): ${String(error)}\n`)}
 }
 await run(['test','./src'])
 }
 await run(['perf/scroll8-idle.ts'])
})
// Revised scope: one quick app-wide scheduling control, no resource tuning.
await batch(async()=>{
 await run(['perf/scroll8.ts','experimental-frame-draw-0','dark','0'],{SCROLL8_SCENES:'summary,changes,timeline',KYBERN_SCROLL_LAYOUT:'1',KYBERN_SCROLL_ISLANDS:'1',KYBERN_SCROLL_COALESCE:'0',KYBERN_INPUT_FRAME_DRAW:'1'})
 for(const variant of ['before','frame-draw']){
  await run(['perf/scroll8.ts',`pointer-${variant}-0`,'dark','0'],{SCROLL8_SCENES:'summary',SCROLL8_INPUT:'pointer',KYBERN_SCROLL_LAYOUT:'1',KYBERN_SCROLL_ISLANDS:'1',KYBERN_SCROLL_COALESCE:'pr',KYBERN_INPUT_FRAME_DRAW:variant==='frame-draw'?'1':'0'})
 }
 for(const variant of ['pr','frame-draw']){
  await run(['perf/scroll8.ts',`ungated-${variant}-0`,'dark','0'],{SCROLL8_UNGATED:'1',SCROLL8_SCENES:'summary',KYBERN_SCROLL_LAYOUT:'1',KYBERN_SCROLL_ISLANDS:'1',KYBERN_SCROLL_COALESCE:'pr',KYBERN_INPUT_FRAME_DRAW:variant==='frame-draw'?'1':'0'})
 }
})
}
await batch(async()=>{
 for(const theme of ['dark','light'])for(const reduce of ['0','1']){
  await run(['perf/scroll8-visual.ts',theme,reduce],{KYBERN_SCROLL_LAYOUT:'1',KYBERN_SCROLL_ISLANDS:'1'})
  await run(['perf/scroll8-visual.ts',theme,reduce],{KYBERN_SCROLL_LAYOUT:'0',KYBERN_SCROLL_ISLANDS:'0',SCROLL8_VISUAL_LABEL:'app-before'})
  await run(['perf/scroll8-webkit.ts',theme,reduce],{SCROLL8_VISUAL:'1'})
  for(const scene of ['list','summary','changes','timeline']){
   const prefix=`${out}/pair-${theme}-${reduce}-${scene}`
   const c=Bun.spawn(['swift','visual/compose.swift',`${out}/desktop-webkit-120hz-${theme}-${reduce}-${scene}.png`,`${out}/app-${theme}-${reduce}-${scene}.png`,`${prefix}.png`,`${prefix}-diff.png`],{stdout:'pipe',stderr:'pipe'})
   const[stdout,stderr,code]=await Promise.all([new Response(c.stdout).text(),new Response(c.stderr).text(),c.exited]);appendFileSync(`${out}/visual-comparison.log`,`${prefix}: ${stdout}${stderr}`)
   if(code)throw Error(`Visual composition ${prefix}`)
   const ab=`${out}/app-cache-${theme}-${reduce}-${scene}`
   const control=Bun.spawn(['swift','visual/compose.swift',`${out}/app-before-${theme}-${reduce}-${scene}.png`,`${out}/app-${theme}-${reduce}-${scene}.png`,`${ab}.png`,`${ab}-diff.png`,'0'],{stdout:'pipe',stderr:'pipe'})
   const[co,ce,cc]=await Promise.all([new Response(control.stdout).text(),new Response(control.stderr).text(),control.exited]);appendFileSync(`${out}/app-cache-comparison.log`,`${ab}: ${co}${ce}`)
   if(cc)throw Error(`Full-app cache control ${ab}`)

  }
 }
})
