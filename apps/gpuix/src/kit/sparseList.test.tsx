import {test,expect} from 'bun:test'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import path from 'node:path'
import {useSparseList} from './sparseList.tsx'
const entry=createRequire(import.meta.url).resolve('@gpuix/react')
const {createRoot,flushSync}=await import(pathToFileURL(path.join(path.dirname(entry),'reconciler/reconciler.js')).href)
test('unchanged semantic metadata does not resend history on local window updates',async()=>{
 let state:ReturnType<typeof useSparseList>
 const renderer={applyBatch(){return []},setWindowKeyEvents(){},setWindowSelectionChange(){}}
 function Fixture({keys,heights,layout}:{keys:string[];heights:number[];layout:number}){state=useSparseList(keys,heights,layout);return <div/>}
 const root=createRoot(renderer)
 try{
  flushSync(()=>root.render(<Fixture keys={['a','b']} heights={[30,50]} layout={0}/>))
  const first=state!.props,indices=state!.indices
  flushSync(()=>root.render(<Fixture keys={['a','b']} heights={[30,50]} layout={0}/>))
  expect(state!.props.sparseVersion).toBe(first.sparseVersion);expect(state!.props.sparseKeys).toBe(first.sparseKeys);expect(state!.indices).toBe(indices)
  flushSync(()=>state!.context.retain('b',true));expect(state!.retained.has('b')).toBe(true)
  state!.context.visited.add('b')
  flushSync(()=>root.render(<Fixture keys={['older','a']} heights={[80,30]} layout={1}/>))
  await Bun.sleep(5);flushSync(()=>{})
  expect(state!.props.sparseVersion).not.toBe(first.sparseVersion);expect(state!.props.sparseLayout).not.toBe(first.sparseLayout)
  expect(state!.indices.get('a')).toBe(1);expect(state!.retained.has('b')).toBe(false);expect(state!.context.visited.has('b')).toBe(false)
 }finally{root.unmount()}
})
