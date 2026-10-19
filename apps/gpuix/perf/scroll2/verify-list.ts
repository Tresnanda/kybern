import assert from 'node:assert/strict'
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs'
import {launchFixture} from '../../src/requests/harness.ts'
import {requireWindowOnscreen,waitForWindowOnscreen} from '../bench/window-onscreen.ts'
const data='/Users/mymac/projects/ade-gpuix-scratch/perf-scroll2',out='/Users/mymac/projects/ade/previews/gpuix/perf/scroll2'
mkdirSync(data,{recursive:true});mkdirSync(out,{recursive:true})
const results=[]
for(const theme of ['dark','light']){
 const fixture=await launchFixture(import.meta.dir+'/list-fixture.tsx',{KYBERN_DATA_DIR:data,KYBERN_CLIENT_CONFIG_DIR:data,KYBERN_URL:'',KYBERN_TOKEN:'',KYBERN_OPAQUE:'1',KYBERN_FULL_RATE:'1',KYBERN_APPEARANCE:theme,TRANSCRIPT_TURNS:'30000',GPUIX_BACKGROUND:'1',SCROLL2_FOCUS_PROBE:'1'})
 try{
 await waitForWindowOnscreen(fixture.pid)
 const app=fixture.app;await app.getByTestId('perf-ready').waitFor()
 const port=JSON.parse(readFileSync(data+'/transcript-control.json','utf8')).port
 const command=async(action:string,index?:number)=>await(await fetch(`http://127.0.0.1:${port}`,{method:'POST',body:JSON.stringify({action,index})})).json() as {anchor:number[]}
 const wait=async(check:()=>Promise<boolean>)=>{const end=Date.now()+10000;while(!await check()){if(Date.now()>end)throw Error('Visible sparse row did not converge');await Bun.sleep(25)}}
 console.log(theme+': sparse jump/focus');await command('jump',15000);await wait(async()=>{try{return (await app.getByTestId('row-15000').bounds()).height>0}catch{return false}})
 await app.getByTestId('sparse-initial-focus').click();await Bun.sleep(200);assert.ok(Math.abs((await command('where')).anchor[0]!-15000)<2,'Sparse focus proxy targeted a physical offset');await app.call('blur',{});
 const first=(await command('where')).anchor,before=await app.getByTestId('row-15000').bounds()
 requireWindowOnscreen(fixture.pid);await app.screenshot({path:`${out}/list-${theme}-middle.png`})
 const tree=await app.call('getTree',{});let slots=0;const visit=(n:NonNullable<typeof tree.tree>)=>{if(n.testId?.startsWith('sidebar-slot:'))slots++;n.children?.forEach(visit)};if(tree.tree)visit(tree.tree)
 assert.ok(slots<160,`30,000 rows retained ${slots} slots`)
 console.log(theme+': prepend');await command('prepend');await wait(async()=>Math.abs((await command('where')).anchor[0]!-first[0]!-50)<2)
 const prepend=(await command('where')).anchor,after=await app.getByTestId('row-15000').bounds()
 assert.ok(Math.abs(before.y-after.y)<1,'Prepend moved stable row pixels')
 console.log(theme+': reverse');await command('reverse');await Bun.sleep(500)
 const reversed=(await command('where')).anchor
 assert.equal(reversed[0],30050-1-prepend[0]!)
 console.log(theme+': tail');console.log('tail jump',JSON.stringify(await command('jump',30049)));await Bun.sleep(500);console.log('tail where',JSON.stringify(await command('where')));console.log('tail paint',JSON.stringify((await app.call('getPaintedText',{})).text.slice(-12)));await wait(async()=>(await app.call('getPaintedText',{})).text.some(t=>t.includes('Prompt older-0')))
 requireWindowOnscreen(fixture.pid);await app.screenshot({path:`${out}/list-${theme}-tail.png`})
 results.push({theme,first,prepend,reversed,slots,stableRowBefore:before,stableRowAfter:after})
 }catch(e){writeFileSync(`${out}/list-${theme}-failed.json`,JSON.stringify({state:await(await fetch(`http://127.0.0.1:${JSON.parse(readFileSync(data+'/transcript-control.json','utf8')).port}`,{method:'POST',body:JSON.stringify({action:'where'})})).json(),tree:await fixture.app.call('getTree',{}),paint:await fixture.app.call('getPaintedText',{})}));try{requireWindowOnscreen(fixture.pid);await fixture.app.screenshot({path:`${out}/list-${theme}-failed.png`})}catch{}throw e}finally{await fixture.close()}
}
writeFileSync(out+'/list-correctness.json',JSON.stringify(results,null,2));console.log('PASS 30,000-row sparse keys, prepend, reorder and retained bounds')
