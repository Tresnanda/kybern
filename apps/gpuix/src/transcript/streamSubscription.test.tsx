import {expect,test} from 'bun:test'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import path from 'node:path'
import {memo} from 'react'
import {set,getState,PaneProvider} from '../state.ts'
import {usePacedBlocks,usePacedAssistant,PACE_MS} from './store.ts'
import {emptyThreadState,type Block} from '../../../../packages/kybern-client/src/transcript.ts'
const entry=createRequire(import.meta.url).resolve('@gpuix/react')
const {createRoot,flushSync}=await import(pathToFileURL(path.join(path.dirname(entry),'reconciler/reconciler.js')).href)

test('paced text updates only the live row, keeps frozen panes and exact completion',async()=>{
  let parent=0,live=0,frozen='',visible=''
  const first:Extract<Block,{kind:'assistant'}>={kind:'assistant',id:'stream#0',messageId:'stream',segment:0,turnId:'turn',at:'now',seq:10001,origin:{kind:'root'},text:'Readable prefix ',thinking:'',complete:false}
  const history=Array.from({length:3000},(_,i):Block=>({kind:'notice',id:String(i),turnId:String(i),seq:i,at:'now',level:'info',text:'settled'}))
  set({selectedId:'stream-thread',open:{...emptyThreadState(),loaded:true,blocks:[...history,first]}})
  const snapshot=getState()
  const renderer={applyBatch(){return []},setWindowKeyEvents(){},setWindowSelectionChange(){}}
  const root=createRoot(renderer)
  const Row=memo(function Row({block}:{block:typeof first}){visible=usePacedAssistant(block).text;live++;return <text>{visible}</text>})
  function Parent(){parent++;const blocks=usePacedBlocks();return <Row block={blocks.at(-1) as typeof first}/>}
  function Frozen(){frozen=usePacedAssistant(first).text;return null}
  const settle=async()=>{await Bun.sleep(PACE_MS+10);flushSync(()=>{});await Bun.sleep(1)}
  try {
    flushSync(()=>root.render(<><Parent/><PaneProvider id="captured" snapshot={snapshot}><Frozen/></PaneProvider></>));await settle()
    const parents=parent,rows=live
    for(let n=0;n<4;n++) {
      const next={...first,text:first.text+'漢字 🌿 '.repeat(n+1)}
      flushSync(()=>set({open:{...getState().open,blocks:[...history,next]}}));await settle()
      expect(visible).toBe(next.text)
    }
    expect(parent).toBe(parents);expect(live).toBeGreaterThan(rows);expect(frozen).toBe(first.text)
    const final={...first,text:'Exact final 🌿 é 漢字',complete:true}
    flushSync(()=>set({open:{...getState().open,blocks:[...history,final]}}));await settle()
    expect(visible).toBe(final.text);expect(parent).toBeGreaterThan(parents)
  }finally{flushSync(()=>root.unmount());set({selectedId:null,open:emptyThreadState()})}
})
