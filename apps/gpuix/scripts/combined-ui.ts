/** Whole-window merged-client tour. Uses explicit scratch state, never sends a turn. */
import path from 'node:path'
import {mkdirSync,writeFileSync} from 'node:fs'
import {launchFixture} from '../src/requests/harness.ts'
const data=process.env.KYBERN_DATA_DIR!,out=process.env.KYBERN_VERIFY_OUTPUT!
if(!data || (!data.includes('gpuix-scratch')&&!data.endsWith('/apps/gpuix/.combined/data')) || !out || !process.env.KYBERN_GPUIX_THREAD) throw Error('Set scratch data, populated thread and output directory')
mkdirSync(out,{recursive:true})
let failures=0
for(const variant of ['dark','light']) {
 writeFileSync(path.join(data,'gpuix-ui.json'),'{}')
 const f=await launchFixture(path.join(import.meta.dir,'../src/main.tsx'),{GPUIX_BACKGROUND:'1',KYBERN_APPEARANCE:variant,KYBERN_DATA_DIR:data,KYBERN_URL:'',KYBERN_TOKEN:''})
 const a=f.app
 const settle=async()=>{await a.clock.fastForward(400);await Bun.sleep(300)}
 const click=async(id:string)=>{await a.getByTestId(id).waitFor({timeoutMs:10000});await a.getByTestId(id).click();await settle()}
 const shot=async(name:string)=>{await a.screenshot({path:path.join(out,`combined-${name}-${variant}.png`)})}
 const check=async(name:string,fn:()=>Promise<void>)=>{try{await fn();console.log('PASS',variant,name)}catch(e){failures++;console.error('FAIL',variant,name,String(e));await shot('failure-'+name).catch(()=>{})}}
 try {
  await a.getByTestId('app-ready').waitFor({timeoutMs:60000});await a.getByTestId('composer').waitFor({timeoutMs:60000});await a.clock.pause();await settle()
  await check('thread',async()=>{if(!await a.getByTestId('user-bubble').count()) throw Error('No populated user bubbles');await shot('thread')})
  for(const [page,id] of [['notes','notes-new'],['tasks','task-new'],['pulls','pr-search'],['usage','usage-stats'],['settings','settings-worktrees']]) await check(page!,async()=>{await click(`rail-${page}`);await a.getByTestId(id!).waitFor({timeoutMs:15000});await shot(page!)})
  await click('rail-home')
  await check('environment',async()=>{await click('environment-toggle');await a.getByTestId('environment-note').waitFor({timeoutMs:10000});await shot('environment');await click('environment-toggle')})
  await check('dock',async()=>{await a.getByTestId('app-ready').press('cmd-j');await settle();await a.getByTestId('dock-tabs').waitFor();await shot('dock')})
  for(const tab of ['agents','activity','changes','review','terminal','artifacts','explorer','notes','tasks','preview']) await check('dock-'+tab,async()=>{await click('dock-add');await click(`dock-add-${tab}`);await shot('dock-'+tab)})
 }finally{console.log(f.diagnostics());await f.close()}
}
if(failures)throw Error(`${failures} whole-app checks failed`)
