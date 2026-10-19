// Extend the existing transcript fixture with deterministic tail growth only.
import {readFileSync} from 'node:fs'
Bun.plugin({name:'flick-follow-growth',setup(build){
 build.onLoad({filter:/\/perf\/transcript\/fixture\.tsx$/},args=>{
  const source=readFileSync(args.path,'utf8')
  const anchor=" if(b.action==='wheel-drive')"
  if(!source.includes(anchor))throw Error('Transcript control anchor moved')
  return {loader:'tsx',contents:source.replace(anchor,` if(b.action==='prepend'){
   const s=getState(),prefix=Array.from({length:20},(_,i)=>s.open.blocks.slice(0,3).map((block,j)=>({...block,id:'older-'+i+'-'+block.id,turnId:'older-'+i,seq:-100+i*3+j,...(block.kind==='assistant'?{messageId:'older-answer-'+i}:{})}))).flat()
   set({open:{...s.open,blocks:[...prefix,...s.open.blocks]}})
   return Response.json({prepended:20})
  }
  if(b.action==='grow'){
   const s=getState(),last=[...s.open.blocks].reverse().find(block=>block.kind==='assistant')!
   const text=last.kind==='assistant'?last.text+'\\n\\n'+Array.from({length:20},(_,i)=>'Follow growth paragraph '+i+'. Preserve **formatting** and reading position.').join('\\n\\n'):''
   set({open:{...s.open,blocks:s.open.blocks.map(block=>block===last?{...last,text}:block)}})
   return Response.json({grown:true})
  }
`+anchor)}
 })
}})
await import('../transcript/fixture.tsx')
