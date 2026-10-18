import path from 'node:path'
if(process.env.MD_PR_BEFORE==='1')Bun.plugin({name:'markdown-pr-before',setup(build){
 build.onLoad({filter:/\/src\/pulls\/PrDetail\.tsx$/},args=>{
  const root=path.resolve(import.meta.dir,'../../../..')
  const source=Bun.spawnSync(['git','show',`d4269d55:${path.relative(root,args.path)}`],{cwd:root})
  if(source.exitCode)throw Error(source.stderr.toString())
  return{contents:source.stdout.toString(),loader:'tsx'}
 })
}})
if(process.env.MARKDOWN_NATIVE_WHEEL==='1') await import('../explorer/app.ts')
else await import('../../src/main.tsx')
