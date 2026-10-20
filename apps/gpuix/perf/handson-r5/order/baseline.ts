import {mkdirSync,writeFileSync} from 'node:fs'
import {execFileSync} from 'node:child_process'
import path from 'node:path'
export function prepareBaseline(){
 const root=path.resolve(import.meta.dir,'../../../../..'),out='/Users/mymac/projects/ade-gpuix-scratch/hr5-order-baseline-source'
 for(const file of ['state.ts','shell/Connection.tsx','nav/overlay.tsx','transcript/images.tsx']){
  const target=path.join(out,file);mkdirSync(path.dirname(target),{recursive:true})
  writeFileSync(target,execFileSync('git',['show',`e1ffabf63:apps/gpuix/src/${file}`],{cwd:root}))
 }
}
if(import.meta.main)prepareBaseline()
