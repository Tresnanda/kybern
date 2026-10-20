import {test,expect} from 'bun:test'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import path from 'node:path'
import {TranscriptRowStateScope} from './rowStateScope.ts'
import {useRowState,resetRowState} from './store.ts'

const entry=createRequire(import.meta.url).resolve('@gpuix/react')
const {createRoot,flushSync}=await import(pathToFileURL(path.join(path.dirname(entry),'reconciler/reconciler.js')).href)

test('transcript disclosures survive body disposal beyond the global fallback cache',()=>{
  const scope=new Map<string,unknown>(),setters=new Map<number,(value:boolean)=>void>(),values=new Map<number,boolean>()
  const renderer={applyBatch(){return []},setWindowKeyEvents(){},setWindowSelectionChange(){}}
  function Body({index}:{index:number}){
    const [value,setValue]=useRowState(`scope-test:${index}`,false)
    setters.set(index,setValue);values.set(index,value)
    return null
  }
  const root=createRoot(renderer)
  try{
    flushSync(()=>root.render(<TranscriptRowStateScope.Provider value={scope}>{Array.from({length:2002},(_,index)=><Body key={index} index={index}/>)}</TranscriptRowStateScope.Provider>))
    flushSync(()=>{for(const set of setters.values())set(true)})
    flushSync(()=>root.render(null))
    flushSync(()=>root.render(<TranscriptRowStateScope.Provider value={scope}><Body index={0}/></TranscriptRowStateScope.Provider>))
    expect(values.get(0)).toBe(true)
    expect(scope.size).toBe(2002)
    flushSync(()=>root.render(null))
    flushSync(()=>root.render(<TranscriptRowStateScope.Provider value={new Map()}><Body index={0}/></TranscriptRowStateScope.Provider>))
    expect(values.get(0)).toBe(false)
  }finally{root.unmount();resetRowState()}
})
