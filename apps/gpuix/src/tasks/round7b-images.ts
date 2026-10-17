import {spawnSync} from 'node:child_process'
import {writeFileSync} from 'node:fs'
const out='/Users/mymac/projects/ade/previews/gpuix/round7/tasks7b'
const pairs=[]
for(const theme of ['dark','light'])for(const motion of ['normal','reduced']){
 const label=`strip-${theme}-${motion}`
 for(const kind of ['carry','cancel']){
  const names=kind==='carry'?['move-1','move-10','move-30','move-60']:['cancel-0','cancel-80','cancel-160','cancel-300']
  const files=['webkit','native'].flatMap(engine=>names.map(name=>`${out}/${label}-${engine}-${name}.png`))
  const output=`${label}-${kind}.png`
  const result=spawnSync('swift',['src/tasks/round7b-strip.swift',`${out}/${output}`,`${theme} ${motion} ${kind}`,...files],{encoding:'utf8'})
  if(result.status)throw Error(result.stderr)
  pairs.push({mode:`${theme}-${motion}`,kind,file:output,top:'Desktop frontend in WebKit',bottom:'GPUIX native',note:'Matching fresh list state and vertical input positions. Screenshots are separate from the timing runs.'})
 }
 const mode=`${theme}-${motion}-1280`
 for(const state of ['board','quick']){
  const result=spawnSync('swift',['visual/compose.swift',`${out}/${mode}-tauri-${state}.png`,`${out}/${mode}-${state}.png`,`${out}/${mode}-pair-${state}.png`,`${out}/${mode}-diff-${state}.png`],{encoding:'utf8'})
  if(result.status)throw Error(result.stderr)
  pairs.push({mode,kind:state,file:`${mode}-pair-${state}.png`,left:'Desktop frontend in WebKit',right:'GPUIX native',diagnostic:result.stdout.trim()})
 }
}
writeFileSync(`${out}/image-index.json`,JSON.stringify(pairs,null,2))
console.log('Created',pairs.length,'labelled comparisons')
