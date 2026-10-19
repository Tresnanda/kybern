import assert from 'node:assert/strict'
import path from 'node:path'
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs'
import {launchFixture} from '../../src/requests/harness.ts'
const data='/Users/mymac/projects/ade-gpuix-scratch/perf-flick-snapshot',out='/Users/mymac/projects/ade/previews/gpuix/perf/flick/snapshot';mkdirSync(out,{recursive:true})
const results=[]
for(const flag of ['0','1']){
 const f=await launchFixture(path.join(import.meta.dir,'snapshot-app.tsx'),{KYBERN_DATA_DIR:data,KYBERN_CLIENT_CONFIG_DIR:data,KYBERN_URL:'',KYBERN_TOKEN:'',GPUIX_BACKGROUND:'1',KYBERN_INPUT_FRAME_DRAW:flag})
 try{
  await f.app.getByTestId('snapshot-ready').waitFor()
  const {port}=JSON.parse(readFileSync(path.join(data,'snapshot-control.json'),'utf8'))
  let previous=10
  for(const moved of [true,false,true]){
   const r=await(await fetch(`http://127.0.0.1:${port}`,{method:'POST',body:JSON.stringify({moved})})).json() as {before:{x:number};after:{x:number};tree:unknown}
   const expected=moved?120:10
   const find=(node:any):any=>Array.isArray(node)?node.map(find).find(Boolean):node?.testId==='snapshot-moving'?node:(node?.children??[]).map(find).find(Boolean)
   assert.equal(r.before.x,flag==='1'?previous:expected,'ordinary painted-bounds read must not draw in display-paced mode')
   assert.equal(find(r.tree)?.bounds?.x,expected,'synchronous tree snapshot must finish its requested paint')
   assert.equal(r.after.x,expected,'snapshot must publish fresh painted bounds')
   results.push({flag,moved,before:r.before,after:r.after});previous=expected
  }
  await f.app.getByTestId('snapshot-moving').click()
  await f.app.screenshot({path:`${out}/frame-${flag}.png`})
 }finally{await f.close()}
}
writeFileSync(out+'/result.json',JSON.stringify(results,null,2));console.log('PASS synchronous snapshot bounds and display-paced ordinary updates')
