import '../src/native/local-build.ts'
import { PR_SCROLL_LAYOUT } from '../src/pulls/scroll-layout.ts'
import {motion,render,useGpuix,type PublicInstance} from '@gpuix/react'
import {useState,useRef} from 'react'
import {THEMES} from '../src/theme.ts'
import {cachedMarkdownTheme} from '../src/transcript/kit.tsx'
import {desktopDiffTheme} from '../src/native/diff.ts'
import {nativeCapabilities} from '../src/native/api.ts'
import {largeSample} from './diff-sample.ts'
const SCROLL=process.env.SCROLL8_LAB_UNGATED==='1'?{}:PR_SCROLL_LAYOUT
const t=THEMES[process.env.KYBERN_APPEARANCE==='light'?'light':'dark']
const body=Array.from({length:40},(_,i)=>`### Verification ${i+1}\n\nPreserve **formatted content**, reading position and selection while scrolling.\n\n- Stable rows keep their identity.\n- The complete description remains reachable.\n\n\`row.id\` survives a refresh. [Open link](https://example.com/scroll8)`).join('\n\n')
function Lab(){
 const {renderer}=useGpuix();const prose=useRef<PublicInstance|null>(null);const[width,setWidth]=useState(660),[changed,setChanged]=useState(false),[scene,setScene]=useState('summary'),[result,setResult]=useState(''),[dimmed,setDimmed]=useState(false),[faded,setFaded]=useState(false),[settles,setSettles]=useState(0)
 return <div {...SCROLL} testId="ready" tabIndex={0} onKeyDown={e=>{if((e.key==='e'||e.key==='c')&&renderer){const r=renderer as unknown as {simulateScrollPhase:(x:number,y:number,dx:number,dy:number,phase:string)=>void};r.simulateScrollPhase(350,330,0,0,'started');r.simulateScrollPhase(350,330,0,e.key==='e'?-120:-80,'moved');r.simulateScrollPhase(350,330,0,0,e.key==='e'?'ended':'cancelled')}if(e.key==='o')setDimmed(v=>!v);if(e.key==='m')setFaded(v=>!v);if(e.key==='s'&&renderer&&prose.current)nativeCapabilities(renderer).setTextSelection(prose.current.id,0,0,4);if(e.key==='h')setResult(JSON.stringify(renderer?.getPaintedHighlights?.()));if(e.key==='g')setResult(renderer?.getSelectedText?.()??'');if(e.key==='w')setWidth(v=>v===660?430:660);if(e.key==='u')setChanged(v=>!v)}} style={{width:'100%',height:'100%',display:'flex',flexDirection:'column',backgroundColor:t.surface,opacity:dimmed?.6:1}}>
 <div style={{display:'flex',height:36}}>{['summary','list','diff'].map(value=><div key={value} testId={value} onClick={()=>setScene(value)} style={{width:90,height:36}}><text style={{color:t.text}}>{value}</text></div>)}</div>
 <text testId="result" style={{color:t.text,height:24,maxHeight:24,flexShrink:0,whiteSpace:"nowrap",overflow:"hidden"}}>{result}</text>
 <text testId="opacity-state" style={{position:'absolute',width:0,height:0,opacity:0}}>{dimmed?'dim':'full'}</text>
 <text testId="motion-state" style={{position:'absolute',width:0,height:0,opacity:0}}>{`${faded?'dim':'full'} ${settles}`}</text>
 <motion.div onMotionComplete={()=>setSettles(n=>n+1)} initial={false} animate={{opacity:faded?.4:1}} transition={{duration:process.env.KYBERN_REDUCED_MOTION==='1'?0:.2,ease:'linear'}} testId="viewport" {...{highlight:{query:"Open link",color:"#ff000030"}}} style={{width,flexGrow:1,minHeight:0,display:'flex',flexDirection:'column'}}>
 {scene==='diff'?<diff {...SCROLL} testId="diff-content" patch={largeSample} scroll theme={desktopDiffTheme(t)} style={{flexGrow:1,minHeight:0}}/>:<virtual-list {...SCROLL} testId="items" estimatedItemHeight={100} style={{flexGrow:1,minHeight:0}}>{scene==='summary'?<div key="summary" style={{padding:24}}><markdown testId="prose" ref={prose} source={(changed?'## Changed content\n\n':'')+body} theme={cachedMarkdownTheme(t)} onLinkClick={e=>setResult(e.value??'')} style={{fontSize:15}}/></div>:Array.from({length:70},(_,i)=><div key={i} testId={`row-${i}`} style={{padding:16,borderBottomWidth:1,borderColor:t.border}}><text style={{color:t.text}}>{`Row ${i}${changed?' changed':''}`}</text><markdown source="Formatted **row** with `code`." theme={cachedMarkdownTheme(t)}/></div>)}</virtual-list>}
 </motion.div></div>
}
render(<Lab/>,{width:728,height:800,title:'Scroll geometry check',focus:false})
