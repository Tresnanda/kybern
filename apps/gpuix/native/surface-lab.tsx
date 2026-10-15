import "../src/native/local-build.ts"
import {render} from "@gpuix/react"
import {useState} from "react"
import {THEMES} from "../src/theme.ts"
import {markdownTheme} from "../src/transcript/kit.tsx"
const light=process.env.KYBERN_APPEARANCE==="light",t=THEMES[light?"light":"dark"]
const legacy=process.env.SURFACE_PERF_LEGACY==="1"
const enabled=process.env.SURFACE_DISABLE!=="1"
function Lab(){
 const [shown,setShown]=useState(true),[click,setClick]=useState("")
 const md={...markdownTheme(t),markdown:{link:{color:"#368ded",underline:"hover" as const,weight:600}}}
 return <div testId="ready" style={{width:"100%",height:"100%",backgroundColor:t.surface,position:"relative",...(!legacy?{fontSize:14,lineHeight:20}:{})}}>
 <div testId="scroll" style={{height:"100%",width:"100%",overflowY:"scroll",padding:24,display:"flex",flexDirection:"column",gap:12}}>
 {Array.from({length:60},(_,i)=><div key={i} style={{height:64,flexShrink:0,backgroundColor:i%2?(light?"#e5efff":"#203553"):(light?"#ffe5dd":"#532c25"),padding:12,...(!legacy?{display:"flex" as const,flexDirection:"column" as const}:{})}}><text style={{color:t.text,fontSize:16,...(!legacy?{lineHeight:20}:{})}}>{legacy?<>Transcript row {i} — sharp text behind the floating surface</>:`Transcript row ${i} — sharp text behind the floating surface`}</text><text style={{color:i%2?"#368ded":"#e36344"}}>BLUE / ORANGE · 0123456789 · live content</text></div>)}
 </div>
 <div style={{position:"absolute",top:130,left:180,width:380,height:260,pointerEvents:"none"}}>
 {shown&&<anchored side="bottom" align="start" gap={-260} deferred priority={2} occlude {...{backdrop:enabled?{blur:16,saturation:1.25,radius:16}:{blur:0}} as object}><div testId="glass" style={{width:380,height:260,padding:24,borderRadius:16,backgroundColor:light?"rgba(255,255,255,0.65)":"rgba(30,32,37,0.65)",borderWidth:1,borderColor:t.border,display:"flex",flexDirection:"column",gap:18,pointerEvents:"auto"}}>
 <text style={{color:t.text,fontSize:20,fontWeight:600}}>Floating surface</text>
 <text style={{color:t.text}}>Foreground stays sharp. The transcript is blurred.</text>
 <markdown testId="link" source="[First link](https://example.com/one) and [second link](https://example.com/two)" theme={md} onLinkClick={e=>setClick(e.value??"")} style={{width:330,userSelect:"text"}}/>
 <text testId="clicked" style={{color:t.text}}>{click||"No link clicked"}</text>
 </div></anchored>}
 </div>
 <div testId="toggle" onClick={()=>setShown(!shown)} style={{position:"absolute",left:24,top:16,width:120,height:30,backgroundColor:t.surface}}><text style={{color:t.text}}>Toggle surface</text></div>
 </div>
}
render(<Lab/>,{title:"Native surface parity",width:728,height:600,focus:false})
