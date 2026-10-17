// Each baseline and each final+WebKit pair takes its own <=5 min fair lease.
import {spawnSync} from 'node:child_process'
import {pacingLock} from './scroll8-lock.ts'
import path from 'node:path'
import {existsSync} from 'node:fs'
const prefix=process.env.SCROLL8_REAL==='1'?'real-':''
const root=path.resolve(import.meta.dir,'../../..')
const builds=async()=>{const start=Date.now();while(spawnSync('pgrep',['-x','rustc']).status===0||spawnSync('pgrep',['-x','cargo']).status===0){if(Date.now()-start>30*60_000)throw Error('Native builds still running; refuse contaminated timing');await Bun.sleep(2000)}}
const run=async(args:string[],env:Record<string,string|undefined>)=>{const c=Bun.spawn(['bun',...args],{env:{...process.env,...env},stdout:'inherit',stderr:'inherit'});if(await c.exited)throw Error(args.join(' '))}
if(process.env.SCROLL8_REAL==='1'&&process.env.SCROLL8_DEEP_REAL!=='1'){
 await builds()
 await run([new URL('scroll8.ts',import.meta.url).pathname,'real-after','dark','0'],{SCROLL8_SCENES:'summary,changes,timeline',KYBERN_SCROLL_LAYOUT:'1',KYBERN_SCROLL_ISLANDS:'1',KYBERN_SCROLL_COALESCE:'pr',KYBERN_INPUT_FRAME_DRAW:'0',KYBERN_FULL_RATE:'1'})
 process.exit(0)
}
for(const theme of ['dark','light'])for(const reduced of ['0','1']){
 await builds()
 await run([new URL('scroll8.ts',import.meta.url).pathname,`${prefix}before`,theme,reduced],{KYBERN_SCROLL_LAYOUT:'0',KYBERN_SCROLL_ISLANDS:'0',KYBERN_SCROLL_COALESCE:'0',KYBERN_INPUT_FRAME_DRAW:'0',KYBERN_PACING_SCREENSHOTS:'0',KYBERN_FULL_RATE:'1'})
 await builds()
 const release=await pacingLock()
 try{
  const parent={KYBERN_PACING_PARENT_LEASE:root}
  await run([new URL('scroll8.ts',import.meta.url).pathname,`${prefix}after`,theme,reduced],{...parent,KYBERN_SCROLL_LAYOUT:'1',KYBERN_SCROLL_ISLANDS:'1',KYBERN_SCROLL_COALESCE:'pr',KYBERN_INPUT_FRAME_DRAW:'0',KYBERN_PACING_SCREENSHOTS:'0',KYBERN_FULL_RATE:'1'})
  const ref=process.env.SCROLL8_REAL==='1'?'desktop-webkit-real-120hz':'desktop-webkit-120hz'
  if(process.env.SCROLL8_REUSE_REFERENCE!=='1'||!existsSync(`/Users/mymac/projects/ade/previews/gpuix/round8/scroll/${ref}-${theme}-${reduced}.json`))await run([new URL('scroll8-webkit.ts',import.meta.url).pathname,theme,reduced],parent)
 }finally{release()}
}
