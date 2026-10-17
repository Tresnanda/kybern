import '../src/native/local-build.ts'
import {dlopen,FFIType,type Pointer} from 'bun:ffi'
import {render,useGpuixRequired} from '@gpuix/react'
import {useEffect,useState} from 'react'
import {MatrixLoader} from '../src/MatrixLoader.tsx'
import {StatusGlyph} from '../src/tasks/Glyphs.tsx'
import {Shimmer} from '../src/transcript/motion.tsx'
import {installFrameSource,onFrame} from '../src/native/frame.ts'
import {each,getObjc,nsApp,sel} from '../src/native/objc.ts'
const regionImage='data:image/svg+xml;base64,'+Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="500" height="40"><path fill="#dd5522" d="M0 0h250v40H0z"/><path fill="#2255dd" d="M250 0h250v40H250z"/></svg>').toString('base64')
const light=process.env.KYBERN_APPEARANCE==='light',fg=light?'#202020':'#eeeeee'
let rawDeliveries=0,rawToken:number|undefined
let deliveries=0,stop:(()=>void)|undefined
let expandedWindow=false
const resize=dlopen('/usr/lib/libobjc.A.dylib',{objc_msgSend:{args:[FFIType.ptr,FFIType.ptr,FFIType.f64,FFIType.f64],returns:FFIType.void}}).symbols.objc_msgSend
function Lab(){
 const renderer=useGpuixRequired(),[shown,setShown]=useState(true),[snapshot,setSnapshot]=useState('Ready'),[color,setColor]=useState(false),[moved,setMoved]=useState(false),[filter,setFilter]=useState(false)
 useEffect(()=>{
  installFrameSource(renderer)
  const o=getObjc(),app=nsApp();if(app)each(o,o.msg(app,sel(o,'windows')) as Pointer,window=>{o.msgSetI64(window,sel(o,'setLevel:'),3n);o.msg(window,sel(o,'orderFrontRegardless'))})
  return()=>stop?.()
 },[renderer])
 return <div testId="app-ready" onKeyDown={e=>{
  if(e.key==='h')setShown(v=>!v)
  if(e.key==='c')setColor(v=>!v)
  if(e.key==='g')setMoved(v=>!v)
  if(e.key==='f')setFilter(v=>!v)
  if(e.key==='w'){expandedWindow=!expandedWindow;const o=getObjc(),app=nsApp();if(app)each(o,o.msg(app,sel(o,'windows')) as Pointer,w=>resize(w,sel(o,'setContentSize:'),expandedWindow?840:560,expandedWindow?320:240))}
  if(e.key==='s'&&!stop)stop=onFrame(()=>{deliveries++})
  if(e.key==='u'){stop?.();stop=undefined}
  if(e.key==='i')setSnapshot(`Callbacks ${deliveries}; raw ${rawDeliveries}`)
  const raw=renderer as unknown as {subscribeAnimationFrames(fn:()=>void):number;acknowledgeAnimationFrame(token:number):void;unsubscribeAnimationFrames(token:number):void}
  if(e.key==='b'&&rawToken===undefined)rawToken=raw.subscribeAnimationFrames(()=>{rawDeliveries++})
  if(e.key==='a'&&rawToken!==undefined)raw.acknowledgeAnimationFrame(rawToken)
  if(e.key==='v'&&rawToken!==undefined){raw.unsubscribeAnimationFrames(rawToken);rawToken=undefined}
  if(e.key==='m')renderer.minimizeWindow?.()
  if(e.key==='r'){const o=getObjc(),app=nsApp();if(app)each(o,o.msg(app,sel(o,'windows')) as Pointer,window=>{o.msgSetPtr(window,sel(o,'deminiaturize:'),null);o.msg(window,sel(o,'orderFrontRegardless'))})}
 }} style={{width:'100%',height:'100%',padding:24,display:'flex',flexDirection:'column',gap:16,backgroundColor:light?'#fafafa':'#202020'}}>
  <text style={{color:fg}}>Display-rate native paint loops</text>
  {shown&&<div cache testId="loops" style={{display:'flex',gap:28,width:500,height:78,position:'relative',marginLeft:moved?12:0}}>{process.env.KYBERN_REGION_IMAGE_TEST==='1'&&<img testId="region-image" src={regionImage} style={{position:'absolute',left:0,top:0,width:500,height:40,opacity:.45,pointerEvents:'none'}}/>}{(['orbit','pulse','scan','twinkle'] as const).map(variant=><div key={variant} style={{display:'flex',flexDirection:'column',gap:10,width:80,height:78}}><MatrixLoader variant={variant} dot={5} gap={process.env.KYBERN_REGION_TIGHT_DOTS==='1'?3:5} alpha={.9} rgb={color?[210,65,45]:light?[30,30,30]:[240,240,240]}/><text style={{color:fg}}>{variant}</text></div>)}<StatusGlyph status="running"/></div>}
  {filter&&<anchored side="bottom" align="start" gap={-50} deferred priority={2} {...{backdrop:{blur:8,saturation:1.2,radius:8}} as object}><div testId="filter" style={{width:160,height:50,borderRadius:8,backgroundColor:light?'rgba(255,255,255,.6)':'rgba(40,40,40,.6)'}}><text style={{color:fg}}>Filter fallback</text></div></anchored>}
  <text testId="result" style={{color:fg}}>{snapshot}</text>
  {shown&&process.env.KYBERN_REGION_TEXT_TEST==='1'?<Shimmer text="Retained native text · selection survives" color={light?'rgba(30,30,30,.4)':'rgba(240,240,240,.4)'}/>:<text style={{color:fg}}>H: unmount · C: recolor · S/U: subscribe/unsubscribe</text>}
 </div>
}
render(<Lab/>,{title:'Native frame-loop verification',width:560,height:240,focus:false})
