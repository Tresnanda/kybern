// Broader frame scheduling stays opt-in. Exercise actual native automation
// ordering and editing before using it in the pointer/wheel timing controls.
import {pacingLock,waitForNativeBuilds} from './scroll8-lock.ts'
import {appendFileSync} from 'node:fs'
import path from 'node:path'
await waitForNativeBuilds()
const release=await pacingLock(),root=path.resolve(import.meta.dir,'../../..')
try{
 for(const args of [['scripts/native-check.ts'],['scripts/secure-input-check.ts'],['native/scroll8-input-check.ts'],['native/fixture.ts','bun','scripts/combined-pointer-check.ts']]){
  const child=Bun.spawn(['bun',...args],{env:{...process.env,KYBERN_INPUT_FRAME_DRAW:'1',SCROLL8_LAB_UNGATED:'1',KYBERN_PACING_PARENT_LEASE:root},stdout:'pipe',stderr:'pipe'})
  const[out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
  appendFileSync('/Users/mymac/projects/ade/previews/gpuix/round8/scroll/app-wide-check.log',out+err);process.stdout.write(out);process.stderr.write(err)
  if(code)throw Error(`${args.join(' ')} failed (${code})`)
 }
}finally{release()}
