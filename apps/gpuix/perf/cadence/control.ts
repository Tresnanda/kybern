// Stable same-binary product control, limited to this lane's edited consumers.
import path from 'node:path'
if(process.env.CADENCE_VISIBILITY_CONTROL==='1') {
 const root=path.resolve(import.meta.dir,'../../../..')
 Bun.plugin({name:'cadence-visibility-control',setup(build){
  build.onLoad({filter:/\/src\/(?:MatrixLoader|ui|tasks\/Glyphs|shell\/Connection|transcript\/(?:motion|Turn|Visual|rows)|subagents\/Elapsed|kit\/(?:Spin|Skeleton))\.tsx$/},args=>{
   const source=Bun.spawnSync(['git','show',`b14b10f1:${path.relative(root,args.path)}`],{cwd:root})
   if(source.exitCode)throw Error(source.stderr.toString())
   const contents=source.stdout.toString()
   return {contents:args.path.endsWith('/transcript/Visual.tsx')&&process.env.CADENCE_LOOP==='visual'?contents.replace('function Skeleton(', 'export function Skeleton('):contents,loader:'tsx'}
  })
 }})
}
