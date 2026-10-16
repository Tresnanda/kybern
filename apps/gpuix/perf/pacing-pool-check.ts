import path from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { pacingLock } from './pacing-lock.ts'
import { actionFixture } from '../src/pulls/verify.fixture.ts'
import { launchFixture } from '../src/requests/harness.ts'
const out='/Users/mymac/projects/ade/previews/gpuix/round7/pacing'
mkdirSync(out,{recursive:true})
const release=await pacingLock()
const results:unknown[]=[]
try {
  for(const variant of ['baseline','pool']) {
    const fixture=actionFixture(),times:number[]=[]
    const f=await launchFixture(path.join(import.meta.dir,'pacing-app.ts'),{...fixture.env,NAPI_RS_NATIVE_LIBRARY_PATH:process.env.KYBERN_PACING_ADDON??path.join(import.meta.dir,'../native/build/gpuix-native.darwin-arm64.node'),KYBERN_FRAME_POOL:variant==='baseline'?'0':'1',KYBERN_PACING_BASELINE:'1',KYBERN_DRAWABLE_TIMES:'1'})
    let problem: string | undefined
    try {
      await f.app.getByTestId('app-ready').waitFor({timeoutMs:30000})
      await f.app.getByTestId('rail-pulls').click();await f.app.getByTestId('pr-row-108').waitFor()
      for(let i=0;i<10;i++) {
        const start=performance.now()
        let timer:ReturnType<typeof setTimeout>|undefined
        try {
          await Promise.race([f.app.screenshot({path:`${out}/pool-${variant}-${i}.png`}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('capture exceeded 2500 ms')),2500)})])
          times.push(performance.now()-start)
          await f.app.getByTestId('pr-row-108').hover()
        } finally {clearTimeout(timer)}
      }
    } catch(e) {problem=String(e)} finally {
      results.push({variant,times,problem,diagnostics:f.diagnostics()})
      writeFileSync(`${out}/drawable-pool.json`,JSON.stringify(results,null,2))
      console.log(JSON.stringify({variant,times,problem}))
      await f.close();fixture.close()
    }
  }
} finally {release()}
