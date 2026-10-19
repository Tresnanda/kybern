import '../src/native/local-build.ts'
import '../src/native/backdrop.ts'
import { render } from '@gpuix/react'
import { useState } from 'react'
import { THEMES } from '../src/theme.ts'
import { markdownTheme } from '../src/transcript/kit.tsx'
import { CodeChunk, CodeHeader } from '../src/transcript/markdown.tsx'
const t = THEMES[process.env.KYBERN_APPEARANCE === 'light' ? 'light' : 'dark']
const code = 'cd ~/projects/ade-gpuix/apps/gpuix\npnpm dev'
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="110"><path fill="#e84c42" d="M0 0H160V110H0Z"/></svg>'
const image = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64')
function Lab() {
  const [tick,setTick] = useState(0), [hit,setHit] = useState('none'), [wrap,setWrap] = useState(false),[paint,setPaint]=useState(false)
  const kinds = ['quad','svg','image','text','backdrop','cached','virtual','nested']
  return <div testId="ready" style={{width:'100%',height:'100%',backgroundColor:t.frame,padding:24,display:'flex',flexDirection:'column',gap:16}}>
    <div style={{display:'flex',gap:12}}>
      <div testId="frame-reference" style={{width:10,height:10,backgroundColor:t.frame}}/>
      <div testId="replay" onClick={()=>setTick(tick+1)} style={{width:120,height:28,backgroundColor:t.surface}}><text style={{color:t.text}}>{`Replay ${tick}`}</text></div>
      <div testId="paint" onClick={()=>setPaint(!paint)} style={{width:80,height:28,backgroundColor:t.surface}}><text style={{color:t.text}}>Paint leaf</text></div>
      <text testId="hit" style={{color:t.text}}>{hit}</text>
    </div>
    {[kinds.slice(0,4),kinds.slice(4)].map((row,i)=><div key={i} style={{display:'flex',gap:16}}>
      {row.map(kind=><div key={kind} style={{display:'flex',flexDirection:'column',gap:4}}>
        <text style={{color:t.text}}>{kind}</text>
        <div style={{position:'relative',width:160,height:110}}>
          <div onClick={()=>setHit('behind')} style={{position:'absolute',left:0,top:0,width:160,height:110,backgroundColor:t.frame}}/>
          <div testId={kind} onClick={()=>setHit(kind)} style={{position:'absolute',left:0,top:0,width:160,height:110,borderRadius:30,overflow:'hidden'}}>
            {kind==='quad'&&<div style={{width:160,height:110,backgroundColor:paint?'#3a87e9':'#e84c42'}}/>}
            {kind==='svg'&&<svg source={svg} style={{width:160,height:110,color:'#e84c42'}}/>}
            {kind==='image'&&<img src={image} style={{width:160,height:110}}/>}
            {kind==='text'&&<text style={{color:'#e84c42',fontSize:60,lineHeight:60,userSelect:'text'}}>MMMMMMMMMMMM</text>}
            {kind==='backdrop'&&<div backdrop={{blur:8,saturation:1.2}} style={{width:160,height:110,backgroundColor:'#e84c42'}}/>}
            {kind==='cached'&&<div cache style={{width:160,height:110}}><div style={{width:160,height:110,backgroundColor:'#e84c42'}}/></div>}
            {kind==='virtual'&&<virtual-list estimatedItemHeight={40} style={{width:160,height:110}}>{Array.from({length:100},(_,j)=><div key={j} cache style={{width:160,height:40,backgroundColor:'#e84c42'}}><text style={{color:'#ffffff'}}>{`row ${j}`}</text></div>)}</virtual-list>}
            {kind==='nested'&&<div style={{width:160,height:110,backgroundColor:'#e84c42',borderTopRightRadius:70,overflow:'hidden'}}><div style={{width:160,height:110,backgroundColor:'#e84c42'}}/></div>}
          </div>
        </div>
      </div>)}
    </div>)}
    <div style={{width:520,display:'flex',flexDirection:'column'}}>
      <CodeHeader part={{kind:'code',text:code,language:'sh',key:'code'}} expanded={false} wrap={wrap} onWrap={()=>setWrap(!wrap)}/>
      <CodeChunk text={code+'\n'+('long line '.repeat(18))} language="sh" wrap={wrap}/>
    </div>
    <div testId="native-md" style={{width:520}}><markdown source={'```sh\n'+code+'\n```'} theme={markdownTheme(t)} style={{userSelect:'text'}}/></div>
    <div testId="long-transcript-frame" style={{width:700,height:160,flexShrink:0}}><virtual-list testId="long-transcript" estimatedItemHeight={130} overdraw={200} style={{width:700,height:160}}>
      {Array.from({length:200},(_,j)=><div key={j} style={{paddingBottom:10}}><markdown source={`### Turn ${j}\n\nCode remains rounded.\n\n\`\`\`sh\n${code}\n\`\`\``} theme={markdownTheme(t)} style={{userSelect:'text'}}/></div>)}
    </virtual-list></div>
  </div>
}
// Leave room for the native title bar on the built-in 1440×900 display.
render(<Lab/>,{title:'Rounded overflow capability',width:760,height:820,focus:false})
