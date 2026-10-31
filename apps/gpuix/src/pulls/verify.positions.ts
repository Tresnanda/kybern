/** ADE-96: native virtual-list anchors survive full PR body unmounts and worker-parsed Summary remounts. */
import assert from 'node:assert/strict'
import path from 'node:path'
import {actionFixture} from './verify.fixture.ts'
import {launchFixture,waitForPainted} from '../requests/harness.ts'
const fixture=actionFixture({horizontal:true,long:true})
const f=await launchFixture(path.join(import.meta.dir,'../main.tsx'),{...fixture.env,KYBERN_WINDOW_SIZE:'1440x900',KYBERN_OPAQUE:'1'})
const a=f.app
const offset=async(id:string)=>(await a.call('getScrollOffset',{elementId:(await a.getByTestId(id).element()).id})).offset
const click=async(id:string)=>{await a.getByTestId(id).click();await Bun.sleep(250)}
try{
 await a.getByTestId('pr-summary').waitFor({timeoutMs:20000});await waitForPainted(a,'Verification 1')
 await a.getByTestId('pr-summary').wheel(0,-1800);await Bun.sleep(400)
 const before=await offset('pr-summary');assert.ok(before&&Math.abs(before[1])>1000)
 await click('tab-chat');await click('tab-pr:pages-fixture:108');await Bun.sleep(600)
 const after=await offset('pr-summary');assert.ok(after&&Math.abs(after[1]-before[1])<1,`Summary anchor restored: ${before} -> ${after}`)
 await click('pr-tab-timeline');await a.getByTestId('pr-timeline-entries').waitFor();await Bun.sleep(400)
 await a.getByTestId('pr-timeline-entries').wheel(0,-1200);await Bun.sleep(300)
 const timeline=await offset('pr-timeline-entries')
 await click('tab-chat');await click('tab-pr:pages-fixture:108');await a.getByTestId('pr-timeline-entries').waitFor();await Bun.sleep(400)
 const returned=await offset('pr-timeline-entries');assert.ok(timeline&&returned&&Math.abs(timeline[1]-returned[1])<1,`Timeline anchor restored: ${timeline} -> ${returned}`)
 console.log(JSON.stringify({summary:{before,after},timeline:{before:timeline,after:returned}}))
}catch(e){console.error(f.diagnostics());console.error((await a.call('getAllText',{})).text.join('\n'));throw e}finally{await f.close();fixture.close()}
process.exit(0)
