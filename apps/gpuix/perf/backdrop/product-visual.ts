// Existing native/WebKit pairs, plus the existing live accessibility check.
import {mkdirSync,writeFileSync} from 'node:fs'
import {onExit} from '../bench/lifetime.ts'
import {requireScreen,keepDisplayAwake} from '../bench/screen-state.ts'
import {seed} from '../bench/seed.ts'
const out='/Users/mymac/projects/ade/previews/gpuix/perf/backdrop/product-visual'
mkdirSync(out,{recursive:true});requireScreen();const stop=keepDisplayAwake(),audit:unknown[]=[]
async function run(args:string[],env:Record<string,string>={}){
 audit.push(requireScreen());writeFileSync(out+'/screen-state.json',JSON.stringify(audit,null,2))
 const child=Bun.spawn(['bun',...args],{env:{...process.env,KYBERN_DATA_DIR:'/Users/mymac/projects/ade-gpuix-scratch/perf-backdrop-visual',KYBERN_CLIENT_CONFIG_DIR:'/Users/mymac/projects/ade-gpuix-scratch/perf-backdrop-visual/client',VISUAL_SCRATCH:'/Users/mymac/projects/ade-gpuix-scratch/perf-backdrop-visual',VISUAL_DAEMON_PORT:'4337',...env},stdout:'inherit',stderr:'inherit'})
 const unregister=onExit(async()=>{child.kill();await child.exited});const code=await child.exited;unregister();if(code)throw Error(`${args[0]} failed`)
 audit.push(requireScreen());writeFileSync(out+'/screen-state.json',JSON.stringify(audit,null,2))
}
try{
 const phase=process.argv[2]??'pairs'
 if(phase==='pairs'){
  for(const kernel of ['0','1'])await run(['scripts/visual-pair.ts','palette','conversation-model','blur-palette','blur-popover','--theme','both','--out',`${out}/kernel-${kernel}`],{KYBERN_BACKDROP_KERNEL:kernel,GPUIX_VISUAL_AREAS:'conversation,settings'})
 }else if(phase==='accessibility'){
  const fixture=await seed('/Users/mymac/projects/ade-gpuix-scratch/perf-backdrop-material',4337)
  try{for(const theme of ['dark','light'])await run(['src/platform/verify.material.ts',out+'/accessibility',theme],{...fixture.env,KYBERN_BACKDROP_KERNEL:'1'})}finally{await fixture.close();fixture.remove()}
 }else throw Error('Expected pairs or accessibility')
}finally{stop()}
