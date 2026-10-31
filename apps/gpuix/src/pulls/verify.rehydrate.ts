/** ADE-96: cold cursor/page rehydration preserves exact later-page reading anchors and selected files. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { actionFixture } from './verify.fixture.ts'
import { launchFixture, waitForPainted } from '../requests/harness.ts'
const fixture=actionFixture({horizontal:true,paged:true,changes:true,slowFiles:true})
const f=await launchFixture(path.join(import.meta.dir,'../main.tsx'),{...fixture.env,KYBERN_WINDOW_SIZE:'1440x900',KYBERN_OPAQUE:'1',KYBERN_REDUCED_MOTION:'1'})
const a=f.app
const target='pr:pages-fixture:108'
const click=async(id:string)=>{await a.getByTestId(id).click();await Bun.sleep(180)}
const calls=(number:number,kind:string)=>fixture.params.filter(p=>p.method==='github.pr.page'&&p.params.number===number&&p.params.kind===kind)
const saved=async(slot:string)=>{await Bun.sleep(500);const ui=JSON.parse(readFileSync(path.join(fixture.env.KYBERN_DATA_DIR,'gpuix-ui.json'),'utf8'));return ui['pulls.views'][`linked:${target}`].scroll[slot] as number[]}
const same=(before:number[],after:number[])=>assert.ok(before[0]===after[0]&&Math.abs(before[1]!-after[1]!)<1,`exact logical anchor: ${before} -> ${after}`)
async function until(check:()=>Promise<boolean>,label:string){const end=Date.now()+15000;while(Date.now()<end){if(await check())return;await Bun.sleep(40)}throw Error(`Timed out: ${label}`)}
async function bottom(last=false){
 const viewport=await a.getByTestId('pr-timeline-entries').bounds()
 for(let i=0;i<30;i++){
  if(last){if((await a.call('getPaintedText',{})).text.join('\n').includes('Timeline item 60'))return}
  else{try{const b=await a.getByTestId('pr-timeline-more').bounds();if(b.y>=viewport.y&&b.y+b.height<=viewport.y+viewport.height)return}catch{}}
  await a.getByTestId('pr-timeline-entries').wheel(0,-1600);await Bun.sleep(100)
 }
 throw Error('Could not reach the loaded timeline end')
}
async function returnOriginal(){await a.call('keystrokes',{keys:'cmd-2'});await Bun.sleep(200)}
async function open(number:number,section:'timeline'|'changes'){
 await click('tabs-add-main');await click('tabs-add-pr');await a.getByTestId('pr-picker-search').fill(String(number));await Bun.sleep(60);await click(`pr-picker-pages-fixture-single-${number}`)
 await a.getByTestId('pr-detail').waitFor();await click(`pr-tab-${section}`)
 await until(async()=>calls(number,section==='timeline'?'timeline':'files').length>0,'page requested')
 if(section==='changes')await until(async()=>calls(number,'files').some(p=>p.params.page===3),'file pages loaded')
 await Bun.sleep(360)
}
try{
 await a.getByTestId('pr-summary').waitFor({timeoutMs:20000});await click('pr-tab-timeline');await a.getByTestId('pr-timeline-entries').waitFor();await Bun.sleep(200)
 await bottom();await click('pr-timeline-more');await until(async()=>calls(108,'timeline').length===2,'second timeline page');await bottom(true);await waitForPainted(a,'Timeline item 60')
 await click('tab-chat');const original=await saved('timeline:all');assert.ok(original[0]!>30,'anchor is in page two')
 // Expiry must refetch both cursor pages before restoration.
 await Bun.sleep(31_000)
 const beforeExpiry=calls(108,'timeline').length
 await returnOriginal();await until(async()=>calls(108,'timeline').length>=beforeExpiry+2,'expired history rehydrated to second page');await waitForPainted(a,'Timeline item 60')
 await click('tab-chat');same(original,await saved('timeline:all'))
 // Eight cached histories are bounded: nine others evict the original.
 for(let number=109;number<=117;number++)await open(number,'timeline')
 const beforeEviction=calls(108,'timeline').length
 await returnOriginal();await until(async()=>calls(108,'timeline').length>=beforeEviction+2,'evicted history rehydrated to second page');await waitForPainted(a,'Timeline item 60')
 await click('tab-chat');same(original,await saved('timeline:all'))
 // Persist a selected file from page three, then evict the metadata/page caches.
 await returnOriginal();await click('pr-tab-changes');await until(async()=>calls(108,'files').some(p=>p.params.page===3),'original third file page');await Bun.sleep(350)
 await a.getByTestId('pr-files-filter').fill('output60');await Bun.sleep(120);await click('pr-file-0');await waitForPainted(a,'output60.tsx');await a.getByTestId('pr-files-filter').fill('');await Bun.sleep(200)
 for(let number=109;number<=117;number++)await open(number,'changes')
 const beforeFiles=calls(108,'files').length
 await returnOriginal();await until(async()=>calls(108,'files').length>beforeFiles,'cold file list requested')
 assert.equal(await a.getByTestId('pr-native-diff').count(),0,'first file is not chosen while saved page-three file is loading')
 await until(async()=>calls(108,'files').slice(beforeFiles).some(p=>p.params.page===3),'saved selected file page fetched')
 await waitForPainted(a,'output60.tsx')
 assert.equal(await a.getByTestId('pr-detail').count(),1,'inactive bodies remain unmounted')
 assert.doesNotMatch(f.diagnostics(),/\[error-boundary\]/)
 console.log(JSON.stringify({pass:true,timelineAnchor:original,expiryPages:2,evictionPages:2,selectedFilePage:3,inactiveBodiesMounted:0}))
}catch(e){console.error(f.diagnostics());console.error((await a.call('getAllText',{})).text.join('\n'));throw e}finally{await f.close();fixture.close()}
process.exit(0)
