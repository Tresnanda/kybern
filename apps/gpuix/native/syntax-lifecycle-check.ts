import '../src/native/local-build.ts'
import assert from 'node:assert/strict'
import path from 'node:path'
import {launchFixture,waitForPainted} from '../src/requests/harness.ts'
const source='/* start\n😀 comment\nend */\nconst x = "é";'
for(const mode of ['dark','light']){
 const f=await launchFixture(path.join(import.meta.dir,'syntax-lab.tsx'),{GPUIX_BACKGROUND:'1',KYBERN_APPEARANCE:mode,SYNTAX_SOURCE:source,SYNTAX_SPLIT:'2'}),a=f.app
 try{
  await a.getByTestId('ready').waitFor()
  const root=(await a.getByTestId('app-ready').element()).id
  const key=async(key:string)=>{await a.call('keyDown',{elementId:root,key});await Bun.sleep(100)}
  const result=()=>a.getByTestId('result').textContent()
  const ready=await a.getByTestId('ready').bounds()
  await a.mouse.down({x:ready.x+28,y:ready.y+10})
  await a.mouse.move({x:ready.x+480,y:ready.y+70},{pressedButton:0})
  await a.mouse.up({x:ready.x+480,y:ready.y+70})
  await key('g');const selection=JSON.parse(await result());assert.equal(selection.text,source,'Cross-range copy lost or duplicated source/newlines')
  await key('m');await key('g');assert.deepEqual(JSON.parse(await result()),selection,'Code remount lost selection identity or copy text')
  await key('t');assert.equal(await result(),source)
  await key('s');assert.match(await result(),/Stale syntax revision/)
  await key('u');await a.getByText('updated').waitFor();await waitForPainted(a,'// edited before range')
  await key('c');await a.getByText('cancelled stale result').waitFor()
  await key('a');await a.getByText('document bound enforced').waitFor()
  await key('p');await a.getByText('queue bound enforced').waitFor()
  await key('i');assert.deepEqual(JSON.parse(await result()),{documents:1,sourceBytes:Buffer.byteLength(source),pending:0})
  await key('x');await a.getByText('released parse cancelled').waitFor()
  await key('i');assert.deepEqual(JSON.parse(await result()),{documents:0,sourceBytes:0,pending:0})
  console.log(`ok ${mode}: cross-range Unicode copy/remount, full source, revisions, cancellation, 32-document/8-worker bounds, release`)
 }catch(e){console.error(f.diagnostics());throw e}finally{await f.close()}
}
