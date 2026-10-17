import '../src/native/local-build.ts'
import { render, useGpuixRequired, type PublicInstance } from '@gpuix/react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Pointer } from 'bun:ffi'
import { each, getObjc, nsApp, sel } from '../src/native/objc.ts'
import { observeElementBounds, type ElementBoundsEvent } from '../src/native/layout.ts'
import { PaintTranslate } from '../src/drag/PaintTranslate.tsx'
const light=process.env.KYBERN_APPEARANCE==='light'
function Lab(){
  useEffect(()=>{const o=getObjc(),app=nsApp();if(app)each(o,o.msg(app,sel(o,'windows')) as Pointer,window=>{o.msgSetI64(window,sel(o,'setLevel:'),3n);o.msgSetBool(window,sel(o,'setIgnoresMouseEvents:'),true);o.msgSetBool(window,sel(o,'setAcceptsMouseMovedEvents:'),false);o.msg(window,sel(o,'orderFrontRegardless'))})},[])
  const renderer=useGpuixRequired(),moving=useRef<PublicInstance|null>(null),events=useRef<ElementBoundsEvent[]>([])
  const [value,setValue]=useState('abc')
  const [tick,setTick]=useState(0),[clicks,setClicks]=useState(0),[show,setShow]=useState(true),[key,setKey]=useState(0),[target,setTarget]=useState(0),[result,setResult]=useState('')
  useLayoutEffect(()=>observeElementBounds(renderer,{testId:'moving'},event=>events.current.push(event)),[])
  const action=(key:string)=>{
    if(key==='m'&&moving.current)renderer.setSubtreeTranslation?.(moving.current.id,{translateX:70,translateY:20})
    if(key==='n'&&moving.current)renderer.setSubtreeTranslation?.(moving.current.id,{translateX:-30,translateY:-20})
    if(key==='z'&&moving.current)renderer.setSubtreeTranslation?.(moving.current.id,{translateX:0,translateY:0})
    if(key==='t')setTick(n=>n+1)
    if(key==='b')setTarget(n=>n===0?100:0)
    if(key==='h')setShow(v=>!v)
    if(key==='r')setKey(n=>n+1)
    if(key==='i')setResult(JSON.stringify(events.current))
  }
  return <div testId="app-ready" onKeyDown={event=>action(event.key??'')} style={{width:'100%',height:'100%',backgroundColor:light?'#f5f5f5':'#202020',color:light?'#202020':'#eeeeee'}}>
    <text testId="status" style={{color:light?'#202020':'#eeeeee'}}>{`Tick ${tick}; clicks ${clicks}`}</text>
    <div testId="slot" style={{position:'absolute',left:20,top:70,width:180,height:150,overflow:'hidden',borderRadius:20,backgroundColor:'#304050'}}>
      {show&&<div key={key} ref={moving} testId="moving" paintTranslate={{initial:false,animate:{translateX:0,translateY:0},transition:{duration:0}}}
        style={{position:'relative',width:130,height:120,overflow:'hidden',borderRadius:14,backgroundColor:'#5070c0',boxShadow:{offsetX:4,offsetY:5,blurRadius:8,spreadRadius:0,color:'rgba(0,0,0,.5)'}}}>
        <PaintTranslate animate={{translateX:0,translateY:0}} style={{position:'absolute',left:0,top:0,width:130,height:120}}>
        <PaintTranslate animate={{translateX:0,translateY:0}} style={{position:'absolute',left:0,top:0,width:130,height:120}}>
        <div cache style={{width:130,height:120}}>
          <text testId="selectable" style={{color:'#ffffff',fontSize:16,userSelect:'text'}}>Retained glyphs and clipping</text>
          <div testId="button" onClick={()=>setClicks(n=>n+1)} role="button" aria-label="Translated button" style={{height:24,width:110,backgroundColor:'#b04060'}}><text style={{color:'#ffffff',pointerEvents:'none'}}>Click moved</text></div>
          <input testId="input" value={value} onChange={event=>setValue(event.value??'')} style={{position:'absolute',left:8,top:70,height:24,width:105,fontSize:12,color:'#ffffff'}}/>
          <div style={{position:'absolute',left:110,top:0,width:60,height:120,backgroundColor:'#a07040',pointerEvents:'none'}}/>
        </div>
        </PaintTranslate></PaintTranslate>
      </div>}
    </div>
    <div {...(process.env.KYBERN_REDUCED_MOTION!=='1'?{paintAnimation:{kind:'matrix',cycleMs:1600}}:{})} style={{position:'absolute',left:500,top:70,width:14,height:14,backgroundColor:'#c08040'}}/>
    <PaintTranslate testId="spring" initial={false} animate={{translateX:target,translateY:0}} transition={process.env.KYBERN_REDUCED_MOTION==='1'?{duration:0}:{type:'spring',duration:.3,bounce:.05}} style={{position:'absolute',left:280,top:70,width:50,height:30,backgroundColor:'#9070e0'}}/>
    <div cache testId="unrelated" style={{position:'absolute',left:260,top:150,width:160,height:50,backgroundColor:'#307050'}}><text style={{color:'#ffffff'}}>Unrelated retained island</text></div>
    <text testId="input-value" style={{position:'absolute',left:450,top:180,color:light?'#202020':'#eeeeee'}}>{value}</text>
    <text testId="result" style={{position:'absolute',left:10,top:230,width:580,height:150,fontSize:8,color:light?'#202020':'#eeeeee'}}>{result}</text>
  </div>
}
render(<Lab/>,{title:'Retained subtree translation',width:600,height:400,focus:false})
