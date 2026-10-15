/** Every destructive action goes only to an in-memory server. */
import assert from 'node:assert/strict'
import path from 'node:path'
import {launchFixture} from '../requests/harness.ts'
import {actionFixture} from './verify.fixture.ts'
const fixture=actionFixture(),mode=process.argv.includes('--light')?'light':'dark'
const f=await launchFixture(path.join(import.meta.dir,'../main.tsx'),{...fixture.env,KYBERN_APPEARANCE:mode})
const a=f.app
const click=async(id:string)=>{console.log('click',id);await a.getByTestId(id).waitFor({timeoutMs:10000});await a.getByTestId(id).click();await Bun.sleep(350)}
try{
 await a.getByTestId('app-ready').waitFor({timeoutMs:60000});await click('rail-pulls');await click('pr-row-108');await a.getByTestId('pr-summary').waitFor()
 for(const action of ['comment','approve','request_changes']){
  await click('pr-review');await a.getByTestId('pr-review-body').fill(`Fixture ${action}`);await Bun.sleep(250);await click(`pr-verdict-${action}`);await click('pr-review-submit')
  assert.equal(fixture.actions.at(-1)?.action,action);assert.equal(fixture.actions.at(-1)?.head_sha,'1234567890abcdef')
 }
 fixture.fail(true);await click('pr-review');await a.getByTestId('pr-review-body').fill('Keep this draft after failure');await Bun.sleep(250);await click('pr-review-submit')
 assert.match(await a.getByTestId('pr-review-popover').textContent(),/Your draft is kept/)
 await a.getByTestId('pr-review-popover').press('escape');await click('pr-review');fixture.fail(false);await click('pr-review-submit');assert.equal(fixture.actions.at(-1)?.body,'Keep this draft after failure')
 for(const action of ['merge','close','checkout']){
  if(action==='merge')await click('pr-merge');else{await click('pr-merge-menu');await click(`pr-${action}`)}
  await click('pr-confirm-submit');assert.equal(fixture.actions.at(-1)?.action,action)
  if(action==='checkout')assert.equal(fixture.actions.at(-1)?.thread_id,'linked')
 }
 fixture.empty(true);await click('pr-refresh');assert.equal(await a.getByTestId('pr-row-108').count(),0)
 console.log(`PASS ${mode}: all six PR actions, reviewed head, linked checkout, failed-review draft retention and empty list; mock RPC only`)
}finally{await f.close();fixture.close()}
