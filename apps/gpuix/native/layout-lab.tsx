import '../src/native/local-build.ts'
import { render, useGpuixRequired, motion } from '@gpuix/react'
import { useRef, useState } from 'react'
import { observeElementBounds, onWindowResize, type ElementBoundsEvent, type WindowResizeEvent } from '../src/native/layout.ts'
const light = process.env.KYBERN_APPEARANCE === 'light'
function Lab() {
 const renderer = useGpuixRequired()
 const events = useRef<{ bounds: ElementBoundsEvent[]; numeric: ElementBoundsEvent[]; row: ElementBoundsEvent[]; spring: ElementBoundsEvent[]; window: WindowResizeEvent[] }>({bounds:[],numeric:[],row:[],spring:[],window:[]})
 const stops = useRef<Array<() => void>>([])
 const [clipWidth,setClipWidth] = useState(160)
 const [left,setLeft] = useState(0), [key,setKey] = useState(0), [show,setShow] = useState(true), [result,setResult] = useState(''), [tick,setTick] = useState(0), [velocity,setVelocity] = useState(0)
 const id = (testId: string) => {
   const tree = JSON.parse((renderer as unknown as {getAutomationTree(): string}).getAutomationTree())
   const find = (n: any): number | undefined => n.testId === testId || n.props?.testId === testId ? n.id : n.children?.map(find).find((id: number | undefined) => id != null)
   const found = Array.isArray(tree) ? tree.map(find).find((id: number | undefined) => id != null) : find(tree)
   if(found==null)throw Error('Missing '+testId);return found
 }
 const action = (keyName: string) => {
  try {
   if(keyName==='s') {
    stops.current.push(onWindowResize(renderer,e=>events.current.window.push(e)),observeElementBounds(renderer,{testId:'target'},e=>events.current.bounds.push(e)),observeElementBounds(renderer,id('target'),e=>events.current.numeric.push(e)),observeElementBounds(renderer,{testId:'row-0'},e=>events.current.row.push(e)))
   } else if(keyName==='w') setClipWidth(120)
   else if(keyName==='o') stops.current.push(observeElementBounds(renderer,{testId:'spring'},e=>events.current.spring.push(e)))
   else if(keyName==='m') setLeft(70)
   else if(keyName==='r') setKey(n=>n+1)
   else if(keyName==='h') setShow(false)
   else if(keyName==='v') setShow(true)
   else if(keyName==='t') setTick(n=>n+1)
   else if(keyName==='i') setResult(JSON.stringify(events.current))
   else if(keyName==='u') {stops.current.forEach(stop=>{stop();stop()});stops.current=[]}
   else if(keyName==='z') renderer.zoomWindow?.()
   else if(keyName==='l') renderer.scrollToItem?.(id('list'),35)
   else if(keyName==='f') setVelocity(400)
   else if(keyName==='b') setVelocity(-400)
   else if(keyName==='q') {const stop=observeElementBounds(renderer,{testId:'target'},()=>{throw Error('Unsubscribed delivery')});stop();stop()}
   else if(keyName==='d') {observeElementBounds(renderer,{testId:'duplicate'},()=>{});throw Error('Duplicate accepted')}
  }catch(e){setResult(String(e))}
 }
 return <div testId="app-ready" onKeyDown={e=>action(e.key??'')} style={{width:'100%',height:'100%',display:'flex',flexDirection:'column',backgroundColor:light?'#f5f5f5':'#202020',color:light?'#202020':'#eeeeee'}}>
  <text style={{color:light?'#202020':'#eeeeee'}}>{`Native layout and velocity · ${tick}`}</text>
  <div style={{width:clipWidth,height:50,overflow:'hidden'}}><div cache style={{width:240,height:40}}>{show&&<div key={key} testId="target" style={{position:'absolute',left,width:180,height:30,backgroundColor:'#5070c0'}}/>}</div></div>
  <div testId="duplicate" style={{width:1,height:1}}/><div testId="duplicate" style={{width:1,height:1}}/>
  <motion.div testId="spring" initial={{translateX:0,translateY:0}} animate={{translateX:0,translateY:0}} transition={{type:'spring',duration:1,bounce:0.3,velocityX:velocity,velocityY:velocity/2}} style={{width:50,height:30,backgroundColor:'#9070e0'}}/>
  <virtual-list testId="list" estimatedItemHeight={28} style={{width:300,height:100}}>{Array.from({length:40},(_,n)=><div cache key={n} testId={`row-${n}`} style={{width:'100%',height:28}}><text style={{color:light?'#202020':'#eeeeee'}}>{`Row ${n}`}</text></div>)}</virtual-list>
  <text testId="result" style={{fontSize:9,color:light?'#202020':'#eeeeee',height:140}}>{result}</text>
 </div>
}
render(<Lab/>,{title:'Native layout and spring velocity',width:700,height:500,focus:false})
