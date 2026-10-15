/** Two 10 s warmups + 15 s samples of native diff switching, isolated RPC. */
import path from 'node:path'
import {launchFixture} from '../requests/harness.ts'
import {pagesFixture} from '../../scripts/pages-fixture.ts'
for(let run=1;run<=2;run++){
 const fixture=pagesFixture();const f=await launchFixture(path.join(import.meta.dir,'../main.tsx'),{...fixture.env,KYBERN_APPEARANCE:'dark'})
 try{
  const a=f.app;await a.getByTestId('app-ready').waitFor({timeoutMs:60000});await a.getByTestId('rail-pulls').click();await a.getByTestId('pr-row-108').waitFor();await a.getByTestId('pr-row-108').click();await a.getByTestId('pr-summary').waitFor();await a.getByTestId('pr-tab-changes').click();await a.getByTestId('pr-native-diff').waitFor()
  await Bun.sleep(10000)
  const sample=Bun.spawn(['bun',path.join(import.meta.dir,'../../perf/sample.ts'),'15',`PR-${run}=${f.pid}`],{stdout:'inherit',stderr:'inherit'})
  const end=Date.now()+15000;let i=0
  while(Date.now()<end){await a.getByTestId(`pr-file-${i++%3}`).click();await Bun.sleep(700)}
  if(await sample.exited)throw Error('Sample failed')
 }finally{await f.close();fixture.close()}
}
