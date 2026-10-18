import './trace.ts'
import '../cadence/control.ts'
import '../../src/native/local-build.ts'
import {render,useGpuixRequired} from '@gpuix/react'
import {useEffect,useState} from 'react'
import type {Pointer} from 'bun:ffi'
import {each,getObjc,nsApp,sel} from '../../src/native/objc.ts'
import {installFrameSource} from '../../src/native/frame.ts'
const {MatrixLoader}=await import('../../src/MatrixLoader.tsx')
const {SpinIcon}=await import('../../src/kit/Spin.tsx')
const {Skeleton}=await import('../../src/kit/Skeleton.tsx')
const {StatusGlyph}=await import('../../src/tasks/Glyphs.tsx')
const {Spinner}=await import('../../src/shell/Connection.tsx')
const {Shimmer,useStreamEffects}=await import('../../src/transcript/motion.tsx')
const {Skeleton:VisualSkeleton}=await import('../../src/transcript/Visual.tsx')
const {Elapsed}=await import('../../src/subagents/Elapsed.tsx')
const {BoundedMarkdown}=await import('../../src/transcript/markdown.tsx')
const {useLoopVisibility}=await import('../../src/native/loop-visibility.ts')
const light=process.env.KYBERN_APPEARANCE==='light',fg=light?'#202020':'#eeeeee',bg=light?'#fafafa':'#202020'
const scene=process.env.CADENCE_LOOP??'matrix'
const since=Date.now()-12000
function Caret(){const loop=useLoopVisibility();const stream=useStreamEffects('Stable **live** formatted answer.',true,loop.visible);return <div ref={loop.ref}><BoundedMarkdown text="Stable **live** formatted answer." tone="bright" stream={stream}/></div>}
function Contents(){
 if(scene==='none')return null
 if(scene==='matrix')return <div style={{display:'flex',gap:32}}>{(['orbit','pulse','scan','twinkle'] as const).map(variant=><MatrixLoader key={variant} variant={variant} dot={4} gap={4}/>)}</div>
 if(scene==='spin')return <SpinIcon source='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M14 8a6 6 0 0 0-6-6" stroke="black" fill="none"/></svg>' color={fg}/>
 if(scene==='skeleton')return <Skeleton width={300} height={32}/>
 if(scene==='shimmer')return <Shimmer text="Thinking about a smooth interface" color={light?'rgba(30,30,30,.4)':'rgba(240,240,240,.4)'}/>
 if(scene==='task')return <StatusGlyph status="running"/>
 if(scene==='connection')return <Spinner color={fg}/>
 if(scene==='elapsed')return <Elapsed startedAt={since} endedAt={null}/>
 if(scene==='visual')return <VisualSkeleton height={60}/>
 if(scene==='caret')return <Caret/>
 throw Error(scene)
}
function Lab(){
 const renderer=useGpuixRequired(),[offscreen,setOffscreen]=useState(false),[mounted,setMounted]=useState(true)
 useEffect(()=>{
  installFrameSource(renderer)
  const o=getObjc(),app=nsApp();if(app)each(o,o.msg(app,sel(o,'windows')) as Pointer,w=>{o.msgSetI64(w,sel(o,'setLevel:'),3n);o.msgSetBool(w,sel(o,'setIgnoresMouseEvents:'),true);o.msg(w,sel(o,'orderFrontRegardless'))})
 },[renderer])
 return <div testId="app-ready" onKeyDown={e=>{if(e.key==='o')setOffscreen(v=>!v);if(e.key==='h')setMounted(v=>!v);if(e.key==='m')renderer.minimizeWindow?.();if(e.key==='r'){const o=getObjc(),app=nsApp();if(app)each(o,o.msg(app,sel(o,'windows')) as Pointer,w=>{o.msgSetPtr(w,sel(o,'deminiaturize:'),null);o.msg(w,sel(o,'orderFrontRegardless'))})}}} style={{width:'100%',height:'100%',padding:24,backgroundColor:bg,display:'flex',flexDirection:'column',gap:24}}>
  <text style={{color:fg}}>{`Passive loop: ${scene}`}</text>
  <div testId="loop-clip" style={{width:640,height:100,overflow:'hidden',position:'relative'}}>
   <div testId="loop-body" style={{position:'absolute',left:8,top:offscreen?240:8,width:600,height:80,display:'flex',alignItems:'center',gap:24}}>{mounted&&<Contents/>}</div>
  </div>
  <text testId="state" style={{color:fg}}>{offscreen?'clipped':'visible'} / {mounted?'mounted':'unmounted'}</text>
 </div>
}
render(<Lab/>,{title:'Cadence passive loop controls',width:720,height:360,focus:false})

process.stdin.on('end',()=>process.exit(0))
const parent=process.ppid
setInterval(()=>{if(process.ppid!==parent)process.exit(0)},1000).unref()
