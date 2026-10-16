import '../src/native/local-build.ts'
import {render,useGpuixRequired} from '@gpuix/react'
import {useEffect,useState} from 'react'
import type {Pointer} from 'bun:ffi'
import {Shimmer} from '../src/transcript/motion.tsx'
import {each,getObjc,nsApp,sel} from '../src/native/objc.ts'
import {installFrameSource} from '../src/native/frame.ts'
const light=process.env.KYBERN_APPEARANCE==='light'
function Lab(){
 const renderer=useGpuixRequired(),[shown,setShown]=useState(true),[red,setRed]=useState(false),[input,setInput]=useState('')
 useEffect(()=>{installFrameSource(renderer);const o=getObjc(),app=nsApp();if(app)each(o,o.msg(app,sel(o,'windows')) as Pointer,w=>{o.msgSetI64(w,sel(o,'setLevel:'),3n);o.msg(w,sel(o,'orderFrontRegardless'))})},[renderer])
 return <div testId="app-ready" onKeyDown={e=>{if(e.key==='h')setShown(v=>!v);if(e.key==='c')setRed(v=>!v)}} style={{width:'100%',height:'100%',backgroundColor:light?'#fafafa':'#202020',display:'flex',flexDirection:'column',padding:24,gap:20}}>
  <div testId="shimmer-frame" style={{width:250,height:28}}>{shown&&<Shimmer text="Reading source, keeping selection" color={red?'rgba(210,65,45,.4)':light?'rgba(32,32,32,.4)':'rgba(238,238,238,.4)'} size={16} lineHeight={24}/>}</div>
  <input testId="input" value={input} onChange={e=>setInput(e.value??'')} style={{width:250,height:30,color:light?'#202020':'#eeeeee'}}/>
  <text testId="input-value" style={{color:light?'#202020':'#eeeeee'}}>{input}</text>
  <div testId="park" tabIndex={0} onClick={()=>renderer.blur?.()} style={{width:250,height:30}}><text style={{color:light?'#202020':'#eeeeee'}}>Park focus</text></div>
 </div>
}
render(<Lab/>,{title:'Native text paint',width:400,height:220,focus:false})
