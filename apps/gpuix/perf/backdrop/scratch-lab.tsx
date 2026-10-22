// N1 scratch pool: a menu-sized wide backdrop toggled over dense text, with the
// renderer's own gauges on demand (scratch-check.ts drives it).
import '../../src/native/local-build.ts'
import '../../src/native/backdrop.ts'
import {render,useGpuixRequired} from '@gpuix/react'
import {useEffect,useState} from 'react'
const line='The quick brown fox jumps over 13 lazy dogs; 0123456789 WMQgjpy '
function Lab(){
 const renderer=useGpuixRequired() as unknown as {getMemoryStats?:()=>{metalGauges?:number[]}}
 const [open,setOpen]=useState(false),[size,setSize]=useState(0),[tick,setTick]=useState(0),[spin,setSpin]=useState(false),[stats,setStats]=useState('')
 // Presented frames without a backdrop: a ticking label (scene changes every frame).
 useEffect(()=>{if(!spin)return;let alive=true;const step=()=>{if(!alive)return;setTick(t=>t+1);setTimeout(step,8)};step();return()=>{alive=false}},[spin])
 const sizes=[[360,420],[420,480],[180,200]] as const,[w,h]=sizes[size]!
 return <div testId="app-ready" onKeyDown={e=>{
  if(e.key==='o')setOpen(true);if(e.key==='c')setOpen(false);if(e.key==='n')setSize(s=>(s+1)%sizes.length);if(e.key==='p')setSpin(true);if(e.key==='q')setSpin(false)
  if(e.key==='s')setStats(JSON.stringify(renderer.getMemoryStats?.()?.metalGauges??null))
 }} style={{width:'100%',height:'100%',backgroundColor:'#1c1c1c'}}>
  {Array.from({length:60},(_,n)=><text key={n} style={{position:'absolute',left:0,top:n*12,color:n%2?'#f0f0f0':'#6ea8ff',fontSize:11,lineHeight:12,whiteSpace:'nowrap'}}>{line.repeat(4)}</text>)}
  <text testId="tick" style={{position:'absolute',left:8,top:4,color:'#ffcc00'}}>{String(tick)}</text>
  <text testId="stats" style={{position:'absolute',left:8,top:20,color:'#ffcc00'}}>{stats}</text>
  {open&&<div testId="menu" backdrop={{blur:16,saturation:1,radius:16}} style={{position:'absolute',left:240,top:120,width:w,height:h,borderRadius:16,backgroundColor:'rgba(30,30,30,.55)'}}/>}
 </div>
}
render(<Lab/>,{title:'Backdrop scratch pool',width:900,height:720,windowBackground:'opaque',focus:false})
