import assert from 'node:assert/strict'
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs'
import {launchFixture} from '../../src/requests/harness.ts'
import {requireWindowOnscreen,waitForWindowOnscreen} from '../bench/window-onscreen.ts'
const data='/Users/mymac/projects/ade-gpuix-scratch/perf-flick-follow'
const out='/Users/mymac/projects/ade/previews/gpuix/perf/flick/follow';mkdirSync(out,{recursive:true})
const results=[]
for(const theme of ['dark','light']){
 const f=await launchFixture(import.meta.dir+'/follow-entry.ts',{KYBERN_DATA_DIR:data,KYBERN_CLIENT_CONFIG_DIR:data,KYBERN_URL:'',KYBERN_TOKEN:'',GPUIX_BACKGROUND:'1',KYBERN_APPEARANCE:theme,KYBERN_OPAQUE:'1',KYBERN_REDUCED_MOTION:'1',TRANSCRIPT_TURNS:'1000',TRANSCRIPT_COMPACT:'1'})
 try{
  await waitForWindowOnscreen(f.pid)
  const a=f.app;await a.getByTestId('perf-ready').waitFor();await a.getByTestId('message-rail').waitFor();await Bun.sleep(500)
  const {port}=JSON.parse(readFileSync(data+'/transcript-control.json','utf8'))
  const command=async(action:string,index?:number)=>{const response=await fetch(`http://127.0.0.1:${port}`,{method:'POST',body:JSON.stringify({action,index})});assert.ok(response.ok);return response.json()}
  const find=(node:any,predicate:(node:any)=>boolean):any=>Array.isArray(node)?node.map(n=>find(n,predicate)).find(Boolean):predicate(node)?node:(node?.children??[]).map((n:any)=>find(n,predicate)).find(Boolean)
  const tail=async()=>{
   const tree=await a.call('getTree',{}),node=find(tree.tree,(node:any)=>node?.testId?.startsWith('transcript-bottom:'))
   assert.ok(node?.testId,'Tail spacer exists')
   const bottom=await a.getByTestId(node.testId).bounds(),surface=await a.getByTestId('transcript-surface').bounds()
   assert.ok(bottom.y+bottom.height<=surface.y+surface.height+2,'Tail growth keeps bottom within the viewport')
   assert.ok(bottom.y+bottom.height>=surface.y+surface.height-3,'Tail remains at bottom')
   return bottom
  }
  await command('jump',2001);await Bun.sleep(300);await a.getByTestId('message-jump-500').waitFor();await a.getByTestId('message-jump-500').click();await Bun.sleep(1700)
  const firstTree=await a.call('getTree',{}),before=find(firstTree.tree,(node:any)=>node?.testId==='turn-user:user-500')
  assert.ok(before?.id,'Middle row is mounted')
  const beforeBounds=await a.getByTestId('turn-user:user-500').bounds(),anchorBefore=await command('where')
  await command('grow');await Bun.sleep(700)
  const afterTree=await a.call('getTree',{}),after=find(afterTree.tree,(node:any)=>node?.testId==='turn-user:user-500')
  assert.equal(after?.id,before.id,'Unchanged visible row retains its native identity')
  const afterBounds=await a.getByTestId('turn-user:user-500').bounds(),anchorAfter=await command('where')
  assert.ok(Math.abs(beforeBounds.y-afterBounds.y)<1,'Tail growth preserves middle reading position')
  assert.deepEqual(anchorAfter.anchor,anchorBefore.anchor,'Tail growth preserves logical anchor while away')
  await command('prepend');await Bun.sleep(700)
  const prependedTree=await a.call('getTree',{}),prepended=find(prependedTree.tree,(node:any)=>node?.testId==='turn-user:user-500')
  assert.equal(prepended?.id,before.id,'Prepending older history retains visible row identity')
  const prependBounds=await a.getByTestId('turn-user:user-500').bounds()
  assert.ok(Math.abs(beforeBounds.y-prependBounds.y)<1,'Prepending older transcript history preserves row pixels')
  await a.getByTestId('scroll-to-bottom').click();await Bun.sleep(700);const bottomBefore=await tail()
  await command('grow');await Bun.sleep(700);const bottomAfter=await tail()
  requireWindowOnscreen(f.pid);await a.screenshot({path:`${out}/${theme}.png`})
  results.push({theme,rowId:before.id,anchorBefore,anchorAfter,beforeBounds,afterBounds,prependBounds,bottomBefore,bottomAfter})
 }finally{await f.close()}
}
writeFileSync(out+'/results.json',JSON.stringify(results,null,2));console.log('PASS both themes: stable row identity, away anchor, older transcript prepend, tail growth follow-bottom')
