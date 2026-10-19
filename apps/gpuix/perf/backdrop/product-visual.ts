// Existing native/WebKit pairs, plus the existing live accessibility check.
import {mkdirSync,writeFileSync,existsSync} from 'node:fs'
import {onExit} from '../bench/lifetime.ts'
import {requireScreen,keepDisplayAwake} from '../bench/screen-state.ts'
import {seed} from '../bench/seed.ts'
const out='/Users/mymac/projects/ade/previews/gpuix/perf/backdrop/product-visual'
mkdirSync(out,{recursive:true});requireScreen();const stop=keepDisplayAwake(),audit:unknown[]=[]
async function run(args:string[],env:Record<string,string>={}){
 audit.push(requireScreen());writeFileSync(out+'/screen-state.json',JSON.stringify(audit,null,2))
 const child=Bun.spawn(['bun',...args],{env:{...process.env,PLAYWRIGHT_CORE:process.env.PLAYWRIGHT_CORE??'/Users/mymac/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs',KYBERN_URL:'',KYBERN_TOKEN:'',KYBERN_AUTOMATION_WINDOW_FRAME:'80 40 1280 820 0 0 1440 900 ',KYBERN_DATA_DIR:'/Users/mymac/projects/ade-gpuix-scratch/perf-backdrop-visual',KYBERN_CLIENT_CONFIG_DIR:'/Users/mymac/projects/ade-gpuix-scratch/perf-backdrop-visual/client',VISUAL_SCRATCH:'/Users/mymac/projects/ade-gpuix-scratch/perf-backdrop-visual',VISUAL_DAEMON_PORT:'4337',...env},stdout:'inherit',stderr:'inherit'})
 const unregister=onExit(async()=>{child.kill();await child.exited});const code=await child.exited;unregister();if(code)throw Error(`${args[0]} failed`)
 audit.push(requireScreen());writeFileSync(out+'/screen-state.json',JSON.stringify(audit,null,2))
}
try{
 const phase=process.argv[2]??'pairs'
 if(phase==='pairs'){
  for(const kernel of ['0','1']){
   const folder=`${out}/kernel-${kernel}`,scenes=['palette','conversation-model','blur-palette','blur-popover']
   await run(['scripts/visual-pair.ts',...scenes,'--theme','both','--fresh','--gpuix-only','--out',folder],{KYBERN_BACKDROP_KERNEL:kernel,GPUIX_VISUAL_AREAS:'conversation,settings'})
   // Reuse pre-existing desktop captures; rescore exits before creating any UI.
   if(existsSync(folder+'/palette-dark-tauri.png'))await run(['scripts/visual-pair.ts',...scenes,'--theme','both','--gpuix-only','--rescore','--out',folder])
  }
 }else if(phase==='accessibility'){
  const fixture=await seed('/Users/mymac/projects/ade-gpuix-scratch/perf-backdrop-material',4337)
  try{for(const theme of ['dark','light'])await run(['src/platform/verify.material.ts',out+'/accessibility',theme],{...fixture.env,KYBERN_BACKDROP_KERNEL:'1',KYBERN_OPAQUE:'0',KYBERN_REDUCED_TRANSPARENCY:'',KYBERN_INCREASED_CONTRAST:''})}finally{await fixture.close();fixture.remove()}
 }else throw Error('Expected pairs or accessibility')
}finally{stop()}
