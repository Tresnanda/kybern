import {launchFixture} from '../src/requests/harness.ts'
import path from 'node:path'
const f=await launchFixture(path.resolve(process.argv.includes('--fixture')?'scripts/dock2-fixture.tsx':'src/main.tsx'),{GPUIX_BACKGROUND:'1',KYBERN_REDUCED_MOTION:'1'})
try{
 const a=f.app;await a.getByTestId('app-ready').waitFor({timeoutMs:45000});await a.getByTestId('header-title').waitFor({timeoutMs:30000})
 await a.getByTestId('dock-toggle').click();await Bun.sleep(2000)
 for(const id of ['app-ready','right-dock','dock-inline','dock-overlay','dock-add']){try{console.log(id,await a.getByTestId(id).count(),await a.getByTestId(id).bounds())}catch(e){console.log(id,String(e))}}
 console.log('PAINTED',(await a.call('getPaintedText',{})).text.join(' ').slice(-1500))
 await a.screenshot({path:`/Users/mymac/projects/ade/previews/gpuix/audit-2026-10-16/dock-probe-${process.argv.includes('--fixture')?'fixture':'main'}.png`})
}finally{await f.close()}
