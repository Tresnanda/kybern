// Run under drag8's UI lease. All motion uses the real native clock; timing and
// resource runs have no screenshots and no geometry queries inside the loop.
import { mkdirSync, writeFileSync } from 'node:fs'
const out='/Users/mymac/projects/ade/previews/gpuix/round8/drag'
mkdirSync(out,{recursive:true})
const env={...process.env,R8_DATA:'/Users/mymac/projects/ade-gpuix-scratch/round8-drag',R8_OUT:out,R8_LANE:'drag8',R7_LOCK_HELD:'1',KYBERN_FULL_RATE:'1'}
async function run(label:string,extra:Record<string,string>){
  const child=Bun.spawn(['bun','src/tasks/round7b-pacing.ts'],{env:{...env,R7_LABEL:label,...extra},stdout:'pipe',stderr:'pipe'})
  const stdout=new Response(child.stdout).text(),stderr=new Response(child.stderr).text()
  const code=await child.exited
  writeFileSync(`${out}/${label}.log`,await stdout+'\n'+await stderr)
  console.log(label,code)
  if(code)throw Error(`Carry fixture failed: ${label}`)
}
async function resources(){for(let repeat=1;repeat<=2;repeat++)await run(`resources-${repeat}`,{R7_RESOURCES:'1',R8_WARMUP:'1',KYBERN_FRAME_TIMES:'1',R7_LOG:`${out}/resources-${repeat}-frames.log`,KYBERN_APPEARANCE:'dark',KYBERN_REDUCED_MOTION:'0'})}
if(process.argv.includes('--resources'))await resources()
else{
  if(!process.argv.includes('--timing-only')){
    for(const region of ['0','1']){
      const child=Bun.spawn(['bun','native/subtree-translation-check.ts'],{env:{...env,KYBERN_REGION_PAINT:region,KYBERN_VERIFY_OUTPUT:`${out}/native-update`},stdout:'pipe',stderr:'pipe'})
      const stdout=new Response(child.stdout).text(),stderr=new Response(child.stderr).text(),code=await child.exited
      writeFileSync(`${out}/native-final-region-${region}.log`,await stdout+'\n'+await stderr);if(code)throw Error('Native translation check failed')
    }
  }
  for(const theme of ['dark','light'])for(const reduced of ['0','1']){
    const label=`${process.env.R8_TIMING_PREFIX??'carry'}-${theme}-${reduced}`
    await run(label,{KYBERN_APPEARANCE:theme,KYBERN_REDUCED_MOTION:reduced,KYBERN_FRAME_TIMES:'1',R7_LOG:`${out}/${label}-frames.log`})
  }
  if(!process.argv.includes('--timing-only')){
    for(const theme of ['dark','light'])for(const reduced of ['0','1']){
      const label=`carry-repeat-${theme}-${reduced}`
      await run(label,{KYBERN_APPEARANCE:theme,KYBERN_REDUCED_MOTION:reduced,KYBERN_FRAME_TIMES:'1',R7_LOG:`${out}/${label}-frames.log`})
    }
    await resources()
    await run('islands',{R7_ISLANDS:'1',R7_REACT:'1',R7_LOG:`${out}/islands-full-native.log`,KYBERN_APPEARANCE:'dark',KYBERN_REDUCED_MOTION:'0'})
  }
}
