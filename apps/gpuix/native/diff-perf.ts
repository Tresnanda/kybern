import '../src/native/local-build.ts'
import path from 'node:path'
import {launchFixture} from '../src/requests/harness.ts'
for (const run of [1,2]) {
 const f=await launchFixture(path.join(import.meta.dir,'diff-lab.tsx'),{GPUIX_BACKGROUND:'1',DIFF_LARGE:'1'})
 try {
 await f.app.getByTestId('ready').waitFor({timeoutMs:60000});console.log('viewport',await f.app.getByTestId('ready').bounds())
 const sample=async(seconds:number,label:string,quiet=false)=>{const p=Bun.spawn(['bun',path.join(import.meta.dir,'../perf/sample.ts'),String(seconds),`${label}=${f.pid}`],{stdout:quiet?'ignore':'inherit',stderr:'inherit'});if(await p.exited)throw Error('sample failed')}
 await sample(10,'warmup',true);await sample(15,`${process.argv[2]} 30,000-line diff ${run}`)
 }finally{await f.close()}
}
