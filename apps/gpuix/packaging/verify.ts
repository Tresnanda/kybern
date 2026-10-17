import {launchFixture as bundle} from './harness.ts'
import {launchFixture as source} from '../src/requests/harness.ts'
import path from 'node:path'
const mode = process.argv[2] || 'bundle'
const begin = performance.now()
const f = await (mode === 'bundle' ? bundle : source)(path.resolve(import.meta.dir,'../src/main.tsx'), {GPUIX_BACKGROUND:'1',KYBERN_GPUIX_THREAD:'',KYBERN_URL:'',KYBERN_TOKEN:''})
try {
 await f.app.getByTestId('app-ready').waitFor({timeoutMs:45000})
 console.log(mode,'app-ready ms:',(performance.now()-begin).toFixed(0))
 console.log('painted:',(await f.app.call('getPaintedText',{})).text.join(' ').slice(0,800))
 if (process.env.PACKAGE_SCREENSHOT) await f.app.screenshot({path:process.env.PACKAGE_SCREENSHOT})
 for(let sample=1;sample<=2;sample++) {
  await Bun.sleep(10000)
  const child=Bun.spawn(['bun',path.resolve(import.meta.dir,'../perf/sample.ts'),'15',`${mode}-${sample}=${f.pid}`],{stdout:'inherit',stderr:'inherit'})
  await child.exited
 }
 console.log('settled painted:', (await f.app.call('getPaintedText',{})).text.join(' ').slice(0,1200)); console.log(f.diagnostics())
} finally {await f.close()}
