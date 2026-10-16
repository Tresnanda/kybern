import type {Pointer} from 'bun:ffi'
import '../src/native/local-build.ts'
import { render } from '@gpuix/react'
import { useEffect, useState } from 'react'
import {each,getObjc,nsApp,sel} from '../src/native/objc.ts'
const light = process.env.KYBERN_APPEARANCE === 'light'
const fg = light ? '#222222' : '#eeeeee'
function Lab() {
 useEffect(()=>{
  // OS captures must observe presented frames. An occluded macOS window stops
  // its display link. Keep only this small test window visible, without making
  // it key or activating the app, even while other agents open background labs.
  const o=getObjc(),app=nsApp();if(app)each(o,o.msg(app,sel(o,'windows')) as Pointer,window=>{
   o.msgSetI64(window,sel(o,'setLevel:'),3n);o.msg(window,sel(o,'orderFrontRegardless'))
  })
 },[])

 const [fill,setFill]=useState('#dd5533'),[opacity,setOpacity]=useState(1),[left,setLeft]=useState(0),[parentOpacity,setParentOpacity]=useState(1),[show,setShow]=useState(true),[count,setCount]=useState(0),[value,setValue]=useState('focus me')
 return <div testId="app-ready" onKeyDown={e=>{
  if(e.key==='t') { let ticks=0; const timer=setInterval(()=>{setFill(v=>v==='#dd5533'?'#3366dd':'#dd5533'); if(++ticks===8){clearInterval(timer);console.error('[paint-lab] done')}},100) }
  if(e.key==='c')setFill(v=>v==='#dd5533'?'#3366dd':'#dd5533')
  if(e.key==='o')setOpacity(v=>v===1?0.25:1)
  if(e.key==='m')setLeft(v=>v===0?60:0)
  if(e.key==='p')setParentOpacity(v=>v===1?0.5:1)
  if(e.key==='h')setShow(v=>!v)
  if(e.key==='r')setCount(v=>v+1)
 }} style={{width:'100%',height:'100%',backgroundColor:light?'#f5f5f5':'#202020',padding:20}}>
  <text style={{color:fg}}>Native scoped paint · fixed leaf fills and SVG opacity</text>
  <div cache testId="parent" style={{width:420,height:180,opacity:parentOpacity,marginLeft:left,backgroundColor:light?'#dddddd':'#333333'}}>
   <div cache style={{width:180,height:60,display:'flex',gap:20}}>
    {show&&<div testId="fill" style={{width:40,height:40,borderRadius:6,backgroundColor:fill}}/>}
    <svg testId="svg" source={'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><circle cx="20" cy="20" r="18" fill="currentColor"/></svg>'} style={{width:40,height:40,color:'#55aa77',opacity,pointerEvents:'none'}}/>
   </div>
   <div testId="button" onClick={()=>setCount(v=>v+1)} style={{width:180,height:36,backgroundColor:'#665599',hover:{backgroundColor:'#8866bb'}}}><text style={{color:'#ffffff',pointerEvents:'none'}}>{`Clicks ${count}`}</text></div>
   <input testId="input" value={value} onChange={e=>setValue(e.value??'')} style={{width:240,height:32,color:fg}}/>
  </div>
  <text testId="input-value" style={{color:fg}}>{value}</text>
  <div testId="park" style={{width:100,height:30}}/>
 </div>
}
render(<Lab/>,{title:'Scoped paint verification',width:600,height:340,focus:false})
