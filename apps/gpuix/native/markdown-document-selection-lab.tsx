import '../src/native/local-build.ts'
import {render,useGpuixRequired} from '@gpuix/react'
import {useState} from 'react'
import {DocumentMarkdown} from '../src/native/markdownDocument.tsx'
import {markdownTheme} from '../src/transcript/kit.tsx'
import {THEMES} from '../src/theme.ts'
const t=THEMES.dark
const Markdown=process.env.MD_DOCUMENT==='1'?DocumentMarkdown:'markdown'
const source=['Start 😀é.',...Array.from({length:100},(_,i)=>`Middle ${i}.`),'End sentinel.'].join('\n\n')
function App(){
 const renderer=useGpuixRequired(),[result,setResult]=useState('')
 return <div testId="selection-ready" onKeyDown={e=>{if(e.key==='g')setResult(renderer.getSelectedText?.()??'')}} style={{width:'100%',height:'100%',backgroundColor:t.surface,display:'flex',flexDirection:'column'}}>
  <text testId="selection-result" style={{height:32,color:t.text,fontSize:10}}>{result}</text>
  <div testId="selection-scroll" style={{flexGrow:1,minHeight:0,overflowY:'scroll',padding:24}}><Markdown testId="selection-markdown" source={source} theme={markdownTheme(t)} style={{userSelect:'text'}}/></div>
 </div>
}
render(<App/>,{title:'Markdown copy',width:728,height:800,focus:false})
