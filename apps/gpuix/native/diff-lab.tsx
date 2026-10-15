import '../src/native/local-build.ts'
import {useState} from 'react'
import {render} from '@gpuix/react'
import {sample,largeSample} from './diff-sample.ts'
import {THEMES} from '../src/theme.ts'
import {DesktopDiff} from '../src/native/DiffView.tsx'
import {desktopDiffTheme} from '../src/native/diff.ts'
const t=THEMES[process.env.KYBERN_APPEARANCE==='light'?'light':'dark']
function Lab(){ const [result,setResult]=useState(''); return <div testId="ready" style={{width:'100%',height:'100%',padding:24,backgroundColor:t.surface}}>{process.env.DIFF_LARGE==='1'?<diff testId="sample" patch={largeSample} scroll theme={desktopDiffTheme(t)} style={{width:'100%',height:'100%',userSelect:'text'}}/>:<DesktopDiff testId="sample" onLineClick={e=>setResult(`old:${e.oldLine??'-'} new:${e.newLine??'-'}`)} patch={process.env.DIFF_EXPAND==='1'?largeSample:sample} style={{width:'100%',userSelect:'text'}}/>}<text testId="result" style={{color:t.text}}>{result}</text></div> }
render(<Lab/>,{title:'Diff parity',width:728,height:800,focus:false})
