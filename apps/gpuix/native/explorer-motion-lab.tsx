import '../src/native/local-build.ts'
import {render,motion,useGpuixRequired} from '@gpuix/react'
import {useState} from 'react'
import {THEMES} from '../src/theme.ts'
const t=THEMES[process.env.KYBERN_APPEARANCE==='light'?'light':'dark'],reduced=process.env.KYBERN_REDUCED_MOTION==='1'
const arrow='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="m8 4 8 8-8 8" fill="none" stroke="currentColor" stroke-width="3"/></svg>'
function Lab(){
 const renderer=useGpuixRequired(),[open,setOpen]=useState(false),[physical,setPhysical]=useState(false),[done,setDone]=useState(0)
 const capabilities=renderer.getMotionCapabilities?.()
 return <div testId="ready" style={{width:'100%',height:'100%',backgroundColor:t.surface,padding:32,display:'flex',flexDirection:'column',gap:24}}>
 <text testId="capabilities" style={{color:t.text}}>{JSON.stringify(capabilities)}</text>
 <div testId="toggle" onClick={()=>setOpen(!open)} style={{height:28,width:160,backgroundColor:t.hover}}><text style={{color:t.text}}>Toggle rotation</text></div>
 <motion.svg testId="arrow" source={arrow} initial={false} animate={{rotate:open?90:0}} transition={reduced?{duration:0}:{duration:.24,ease:'linear'}} onMotionComplete={()=>setDone(v=>v+1)} style={{width:64,height:64,color:t.text}}/>
 <div testId="physical" onClick={()=>setPhysical(!physical)} style={{height:28,width:160,backgroundColor:t.hover}}><text style={{color:t.text}}>Physical springs</text></div>
 <motion.div testId="layout" initial={false} animate={{width:physical?420:80}} transition={reduced?{duration:0}:{type:'spring',stiffness:360,damping:32,mass:.6}} onMotionComplete={()=>setDone(v=>v+1)} style={{height:32,backgroundColor:t.accentBlue}}/>
 <motion.div testId="swap" initial={false} animate={{translateX:physical?200:0}} transition={reduced?{duration:0}:{type:'spring',stiffness:460,damping:30,mass:.55}} onMotionComplete={()=>setDone(v=>v+1)} style={{width:40,height:32,backgroundColor:t.text}}/>
 <text testId="done" style={{color:t.text}}>{String(done)}</text>
 </div>
}
render(<Lab/>,{title:'Explorer native motion',width:560,height:450,focus:false})
