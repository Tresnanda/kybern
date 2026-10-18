import path from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { launchFixture,waitForPainted } from '../../src/requests/harness.ts'
import { actionFixture } from '../../src/pulls/verify.fixture.ts'
const before=process.argv.includes('--before')
const out='/Users/mymac/projects/ade/previews/gpuix/perf/markdown'
mkdirSync(out,{recursive:true})
for(const theme of ['dark','light']){
 const fixture=actionFixture({long:true})
 const f=await launchFixture(path.join(import.meta.dir,'pr-entry.ts'),{...fixture.env,MD_PR_BEFORE:before?'1':'0',KYBERN_APPEARANCE:theme,KYBERN_WINDOW_SIZE:'1440x900',GPUIX_BACKGROUND:'1',...(before?{NAPI_RS_NATIVE_LIBRARY_PATH:path.resolve(import.meta.dir,'../../native/build/markdown-before.node')}:{})})
 try{
  const a=f.app
  await a.getByTestId('app-ready').waitFor({timeoutMs:60_000});await a.getByTestId('rail-pulls').click();await a.getByTestId('pr-row-108').waitFor();await a.getByTestId('pr-row-108').click();await a.getByTestId('pr-summary').waitFor()
  await waitForPainted(a,'Verification 1',60_000)
  await a.clock.pause();await a.clock.fastForward(1000);await Bun.sleep(500)
  await a.screenshot({path:`${out}/pr-${before?'before':'after'}-${theme}.png`})
  const b=await a.getByTestId('pr-summary').bounds()
  const {tree}=await a.call('getTree',{})
  type Node=NonNullable<typeof tree>
  const find=(n:Node):Node|undefined=>n.testId==='pr-summary'?n:n.children?.map(find).find(Boolean)
  const id=tree&&find(tree)?.id
  if(id==null)throw Error('PR Summary must expose its native scroll node')
  const initial=(await a.call('getScrollOffset',{elementId:id})).offset
  await a.mouse.wheel({x:b.x+b.width/3,y:b.y+b.height/2},0,-650)
  // Native wheel delivery can enter after the automation response. Wait for
  // the real scroll handle, advancing the paused visual clock as needed.
  let offset: number[]|null=null
  for(let i=0;i<100;i++){
   await Bun.sleep(10);await a.clock.fastForward(32)
   offset=(await a.call('getScrollOffset',{elementId:id})).offset
   if(offset&&Math.abs(offset[1]!+650)<.01)break
  }
  if(!offset||Math.abs(offset[1]!+650)>.01)throw Error(`PR wheel did not settle: ${initial} -> ${offset}`)
  await a.clock.fastForward(64)
  writeFileSync(`${out}/pr-${before?'before':'after'}-${theme}-offset.json`,JSON.stringify({initial,offset},null,2))
  await a.screenshot({path:`${out}/pr-${before?'before':'after'}-${theme}-scrolled.png`})
  console.log('captured PR Summary',theme,before?'before':'after')
 }catch(error){console.error(f.diagnostics());throw error}finally{await f.close();fixture.close()}
}
