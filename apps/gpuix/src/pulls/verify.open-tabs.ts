/** ADE-96: picker, grouped identities, reading state, list action and bounded mounts in a real native window. */
import assert from 'node:assert/strict'
import path from 'node:path'
import {mkdirSync} from 'node:fs'
import {actionFixture} from './verify.fixture.ts'
import {launchFixture, waitForPainted} from '../requests/harness.ts'
const fixture=actionFixture({horizontal:true,group:true,picker:true,long:true})
const f=await launchFixture(path.join(import.meta.dir,'../main.tsx'),{...fixture.env,KYBERN_OPAQUE:'1',KYBERN_APPEARANCE:process.env.KYBERN_APPEARANCE ?? 'dark',KYBERN_WINDOW_SIZE:'1440x900'})
const a=f.app
let current='pr:pages-fixture/api:108'
const body=()=>a.getByTestId(`tab-body-${current}`)
const click=async(id:string)=>{if(process.env.KYBERN_VERIFY_TRACE)console.log('click',id);await a.getByTestId(id).click();await Bun.sleep(240)}
const inside=async(id:string)=>{if(process.env.KYBERN_VERIFY_TRACE)console.log('inside',current,id);await body().getByTestId(id).click();await Bun.sleep(240)}
const picker=async()=>{await click('tabs-add-main');await click('tabs-add-pr');await a.getByTestId('pr-picker-search').waitFor()}
const select=async(key:string)=>{await click(`tab-${key}`);current=key}
const painted=async()=>(await a.call('getPaintedText',{})).text.join('\n')
try{
 await a.getByTestId('app-ready').waitFor({timeoutMs:60000})
 await body().getByTestId('pr-summary').waitFor()
 // A real scroll and diff stay exactly where they were during ordinary horizontal switches.
 await inside('pr-tab-changes');await body().getByTestId('pr-native-diff').waitFor()
 await body().getByTestId('pr-file-1').click();await Bun.sleep(250)
 const diff=body().getByTestId('pr-native-diff'),beforeId=(await diff.element()).id
 await diff.wheel(0,-440);await Bun.sleep(300)
 const codeBefore=(await painted()).split('\n').filter(s=>/const row\d+ = render/.test(s))
 assert.ok(codeBefore.length,'actual diff code painted after scrolling')
 await click('tab-chat');await select('pr:pages-fixture/api:108')
 assert.notEqual((await body().getByTestId('pr-native-diff').element()).id,beforeId,'inactive native diff is unmounted')
 assert.deepEqual((await painted()).split('\n').filter(s=>/const row\d+ = render/.test(s)),codeBefore,'diff reading position is exact')
 await picker();await a.call('keystrokes',{keys:'d o c s'});await Bun.sleep(200)
 assert.equal(await a.getByTestId('pr-picker-pages-fixture-api-108').count(),0,'picker opens with keyboard focus in search')
 if(process.env.KYBERN_VERIFY_OUTPUT){mkdirSync(process.env.KYBERN_VERIFY_OUTPUT,{recursive:true});await a.screenshot({path:path.join(process.env.KYBERN_VERIFY_OUTPUT,`picker-${process.env.KYBERN_APPEARANCE ?? 'dark'}.png`)})}
 await a.getByTestId('pr-picker-search').fill('Document SSO');await Bun.sleep(250)
 await click('pr-picker-pages-fixture-docs-108');current='pr:pages-fixture/docs:108'
 await body().getByTestId('pr-summary').waitFor()
 assert.equal(await a.getByTestId('tab-pr:pages-fixture/api:108').count(),1)
 assert.equal(await a.getByTestId('tab-pr:pages-fixture/docs:108').count(),1,'same number in another repo is a separate tab')
 assert.equal(fixture.params.filter(p=>p.method==='github.pr.detail').at(-1)?.params.repo,'docs')
 await inside('pr-tab-timeline');await body().getByTestId('pr-timeline-entries').waitFor()
 await inside('pr-timeline-filter-comments')
 await select('pr:pages-fixture/api:108');assert.equal(await body().getByTestId('pr-changes').count(),1,'each PR keeps its section')
 await picker();await a.getByTestId('pr-picker-search').fill('https://github.com/acme/docs/pull/108');await Bun.sleep(200);await click('pr-picker-url');current='pr:pages-fixture/docs:108'
 assert.equal(await a.getByTestId('tab-pr:pages-fixture/docs:108').count(),1,'opening existing PR focuses it')
 assert.equal(await body().getByTestId('pr-timeline').count(),1,'Timeline remains selected')
 // A registered repo URL works for a PR absent from the loaded list.
 await picker();await a.getByTestId('pr-picker-search').fill('https://github.com/acme/docs/pull/999/files');await Bun.sleep(200);await click('pr-picker-url');current='pr:pages-fixture/docs:999'
 await body().getByTestId('pr-summary').waitFor()
 assert.equal(fixture.params.filter(p=>p.method==='github.pr.detail').at(-1)?.params.number,999)
 await picker();await a.getByTestId('pr-picker-search').fill('https://github.com/unknown/repo/pull/1');await Bun.sleep(200)
 assert.equal(await a.getByTestId('pr-picker-unknown').count(),1,'unregistered repo is refused')
 assert.equal(await a.getByTestId('pr-picker-url').count(),0)
 await click('pr-picker-cancel')
 await picker();await a.getByTestId('pr-picker-search').fill('another Space');await Bun.sleep(200);await click('pr-picker-other-known-single-108');current='pr:other-known:108'
 await body().getByTestId('pr-summary').waitFor()
 assert.equal(fixture.params.filter(p=>p.method==='github.pr.detail').at(-1)?.params.project_id,'other-known','known projects across Spaces remain addressable')
 assert.equal(await a.getByTestId('pr-detail').count(),1,'only the active PR body is mounted')
 // Returning after several other PRs keeps small UI state and rebuilds its released native tree.
 await select('pr:pages-fixture/api:108');await body().getByTestId('pr-native-diff').waitFor()
 assert.notEqual((await body().getByTestId('pr-native-diff').element()).id,beforeId,'inactive PR body was released')
 await waitForPainted(a,'Transcript1.tsx')
 assert.deepEqual((await painted()).split('\n').filter(s=>/const row\d+ = render/.test(s)),codeBefore,'reading position survives opening several other PRs')
 // Ordinary global-list click still selects its detail; only the explicit action returns to a tab.
 await click('rail-pulls');await click('pr-row-docs-108')
 assert.equal(await a.getByTestId('page-pulls').count(),1,'ordinary list click stays on global page')
 await click('pr-row-more-docs-108');await click('pr-row-open-tab');current='pr:pages-fixture/docs:108'
 await body().getByTestId('pr-timeline').waitFor()
 if(process.env.KYBERN_VERIFY_OUTPUT){mkdirSync(process.env.KYBERN_VERIFY_OUTPUT,{recursive:true});await a.screenshot({path:path.join(process.env.KYBERN_VERIFY_OUTPUT,`open-tabs-${process.env.KYBERN_APPEARANCE ?? 'dark'}.png`)})}
 console.log('PASS: known-project picker, grouped identities, URL reuse/rejection, cross-Space lookup, sections/files/native diff position, bounded unmounts, explicit list action')
}catch(e){console.error(f.diagnostics());console.error((await a.call('getAllText',{})).text.join('\n'));if(process.env.KYBERN_VERIFY_OUTPUT)await a.screenshot({path:path.join(process.env.KYBERN_VERIFY_OUTPUT,'open-tabs-failure.png')});throw e}finally{await f.close();fixture.close()}
process.exit(0)
