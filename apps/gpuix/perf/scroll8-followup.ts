// Remaining resource/interaction controls, each under a separate fair UI lease.
import path from 'node:path'
import {pacingLock,waitForNativeBuilds} from './scroll8-lock.ts'
import {appendFileSync} from 'node:fs'
const root=path.resolve(import.meta.dir,'../../..'),out='/Users/mymac/projects/ade/previews/gpuix/round8/scroll'
let leased=false
async function run(args:string[],env:Record<string,string>={}){
 const c=Bun.spawn(['bun',...args],{env:{...process.env,GPUIX_BACKGROUND:'1',...(leased?{KYBERN_PACING_PARENT_LEASE:root}:{}),...env},stdout:'pipe',stderr:'pipe'})
 const[stdout,stderr,code]=await Promise.all([new Response(c.stdout).text(),new Response(c.stderr).text(),c.exited]);appendFileSync(`${out}/followup.log`,`${args.join(' ')}\n${stdout}${stderr}\nexit=${code}\n`);process.stdout.write(stdout);process.stderr.write(stderr)
 if(code)throw Error(args.join(' '))
}
async function batch(task:()=>Promise<void>){await waitForNativeBuilds();const release=await pacingLock();leased=true;try{await task()}finally{leased=false;release()}}
await batch(async()=>{
 await run(['perf/scroll8-experiment-check.ts'])
 for(const theme of ['dark','light'])for(const reduce of ['0','1'])await run(['src/pulls/verify.actions.ts',...(theme==='light'?['--light']:[])],{KYBERN_APPEARANCE:theme,KYBERN_REDUCED_MOTION:reduce})
 await run(['test','./src'])
 await run(['perf/scroll8-idle.ts'])
})
await batch(async()=>{
 await run(['perf/scroll8.ts','default-pr-repeat','dark','0'],{SCROLL8_SCENES:'summary,changes',KYBERN_SCROLL_LAYOUT:'1',KYBERN_SCROLL_ISLANDS:'1',KYBERN_SCROLL_COALESCE:'pr',KYBERN_INPUT_FRAME_DRAW:'0'})
 for(const variant of ['all','frame-draw'])for(let repeat=0;repeat<2;repeat++){
  await run(['perf/scroll8.ts',`experimental-${variant}-${repeat}`,'dark','0'],{SCROLL8_SCENES:'summary,changes',KYBERN_SCROLL_LAYOUT:'1',KYBERN_SCROLL_ISLANDS:'1',KYBERN_SCROLL_COALESCE:variant==='all'?'all':'0',KYBERN_INPUT_FRAME_DRAW:variant==='frame-draw'?'1':'0'})
 }
})
await batch(async()=>{
 for(const variant of ['before','frame-draw'])for(let repeat=0;repeat<2;repeat++){
  await run(['perf/scroll8.ts',`pointer-${variant}-${repeat}`,'dark','0'],{SCROLL8_SCENES:'summary,changes',SCROLL8_INPUT:'pointer',KYBERN_SCROLL_LAYOUT:'1',KYBERN_SCROLL_ISLANDS:'1',KYBERN_SCROLL_COALESCE:'pr',KYBERN_INPUT_FRAME_DRAW:variant==='frame-draw'?'1':'0'})
 }
})
await batch(async()=>{
 for(const variant of ['pr','all'])for(let repeat=0;repeat<2;repeat++){
  await run(['perf/scroll8.ts',`ungated-${variant}-${repeat}`,'dark','0'],{SCROLL8_UNGATED:'1',SCROLL8_SCENES:'summary',KYBERN_SCROLL_LAYOUT:'1',KYBERN_SCROLL_ISLANDS:'1',KYBERN_SCROLL_COALESCE:variant,KYBERN_INPUT_FRAME_DRAW:'0'})
 }
})
await batch(async()=>{
 for(const theme of ['dark','light'])for(const reduce of ['0','1']){
  await run(['perf/scroll8-visual.ts',theme,reduce])
  await run(['perf/scroll8-webkit.ts',theme,reduce],{SCROLL8_VISUAL:'1'})
  for(const scene of ['list','summary','changes','timeline']){
   const prefix=`${out}/pair-${theme}-${reduce}-${scene}`
   const c=Bun.spawn(['swift','visual/compose.swift',`${out}/desktop-webkit-120hz-${theme}-${reduce}-${scene}.png`,`${out}/app-${theme}-${reduce}-${scene}.png`,`${prefix}.png`,`${prefix}-diff.png`],{stdout:'pipe',stderr:'pipe'})
   const[stdout,stderr,code]=await Promise.all([new Response(c.stdout).text(),new Response(c.stderr).text(),c.exited]);appendFileSync(`${out}/visual-comparison.log`,`${prefix}: ${stdout}${stderr}`)
   if(code)throw Error(`Visual composition ${prefix}`)
  }
 }
})
