// Harness only: the product and benchmark control endpoint are unchanged.
// Reuse the Markdown lane's pinned pre-document Explorer source as a diagnostic.
import path from 'node:path'
if(process.env.KYBERN_GPU_LEGACY_EXPLORER==='1')Bun.plugin({name:'gpu-legacy-explorer',setup(build){
 build.onLoad({filter:/\/src\/dock\/(Explorer|MotionFileTree)\.tsx$/},args=>{
  const root=path.resolve(import.meta.dir,'../../../..')
  const relative=path.relative(root,args.path)
  const source=Bun.spawnSync(['git','show',`d4269d55:${relative}`],{cwd:root})
  if(source.exitCode)throw Error(source.stderr.toString())
  return {contents:source.stdout.toString(),loader:'tsx'}
 })
}})
await import('../bench/app.ts')
import {dlopen,FFIType,ptr} from 'bun:ffi'
import {readFileSync} from 'node:fs'
const wheel=dlopen(process.env.KYBERN_GPU_WHEEL!,{explorerStartWheel:{args:[FFIType.f64,FFIType.f64,FFIType.i32,FFIType.f64,FFIType.i32,FFIType.ptr],returns:FFIType.void},explorerFloat:{args:[],returns:FFIType.void}}).symbols
wheel.explorerFloat()
let done:Uint8Array
process.on('SIGUSR1',()=>{
 const p=JSON.parse(readFileSync(process.env.KYBERN_GPU_PLAN!,'utf8')) as {x:number;y:number;count:number;magnitude:number;done:string}
 done=Buffer.from(p.done+'\0');wheel.explorerStartWheel(p.x,p.y,p.count,p.magnitude,0,ptr(done))
})
