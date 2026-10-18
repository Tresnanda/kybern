import '../src/native/local-build.ts'
import { readFileSync } from 'node:fs'
import { useState } from 'react'
import { DocumentMarkdown } from '../src/native/markdownDocument.tsx'
import { nativeCapabilities } from '../src/native/api.ts'
import { render, useGpuixRequired } from '@gpuix/react'
import { transcriptMarkdownStyle, withMarkdownStyle } from '../src/native/markdown.ts'
import { sample } from './markdown-sample.ts'
import { THEMES } from '../src/theme.ts'
import { markdownTheme } from '../src/transcript/kit.tsx'
const mode = process.env.KYBERN_APPEARANCE === 'light' ? 'light' : 'dark'
const t = THEMES[mode]
const base = markdownTheme(t)
const theme = {...base, codeWash:t.codeSurface, metrics:{...base.metrics,mdCodePaddingX:9.6,mdCodePaddingY:8,mdCodeHeaderPaddingY:1.6,codeLineHeight:19.5}, markdown:{...transcriptMarkdownStyle(base.text,t.textSecondary,t.border,t.codeSurface,base.metrics.mdTextSize,base.metrics.codeTextSize),codeWrap:process.env.MD_WRAP==='1'}}
const Markdown = process.env.MD_DOCUMENT === '1' ? DocumentMarkdown : 'markdown'
const supplied=process.env.MD_DOC_SOURCE?readFileSync(process.env.MD_DOC_SOURCE,'utf8'):null
const large = process.env.MD_LARGE === '1'
function Check() {
 const renderer=useGpuixRequired(),api=nativeCapabilities(renderer)
 const [wrap,setWrap]=useState(false),[grid,setGrid]=useState(true),[result,setResult]=useState(''),[narrow,setNarrow]=useState(false)
 const control=(id:string,fn:()=>void)=><div testId={id} onClick={fn} style={{width:100,height:28,backgroundColor:t.buttonSecondary}}><text style={{color:t.text}}>{id}</text></div>
 return <div testId="check-ready" onKeyDown={e=>{if(e.key==='g')setResult(JSON.stringify({text:renderer.getSelectedText?.(),ranges:api.getTextSelection()}));if(e.key==='r')setNarrow(!narrow);if(e.key==='h')setResult(JSON.stringify(renderer.getPaintedHighlights?.()))}} style={{width:'100%',height:'100%',padding:24,backgroundColor:t.surface,display:'flex',flexDirection:'column',gap:20}}>
 <Markdown testId="inline" source="one `😀é` two" theme={theme} style={{width:narrow?60:300,userSelect:'text'}} />
 <div highlight={{query:'one inline code two',color:'#ff000080'}}><Markdown testId="search" source="one `inline code` two" theme={theme} style={{width:300,userSelect:'text'}} /></div>
 <Markdown testId="table" source={'| Left | Center | Right |\n| :-- | :-: | --: |\n| `a` | `b` | `c` |'} theme={withMarkdownStyle(theme,{...theme.markdown,tableGrid:grid,tableBorder:'#ff0000',tableBorderWidth:2,tableHeaderRuleWidth:2})} style={{width:400,userSelect:'text'}} />
 <Markdown testId="wrap-code" source={'```text\n'+('const value = "Unicode 😀é and long words "; ').repeat(4)+'\n```'} theme={withMarkdownStyle(theme,{...theme.markdown,codeWrap:wrap,codeHeader:false})} style={{width:300,userSelect:'text'}} />
 <Markdown testId="hardbreak" source={"first `code`  \nsecond"} theme={theme} style={{width:300,userSelect:'text'}} />
 <div style={{display:'flex',gap:8}}>{control('wrap',()=>setWrap(!wrap))}{control('grid',()=>setGrid(!grid))}</div>
 <text testId="result" style={{color:t.text}}>{result}</text>
 </div>
}
render(process.env.MD_CHECK==='1'?<Check/>:<div testId="ready" style={{width:'100%',height:'100%',padding:24,backgroundColor:t.surface,overflowY:'scroll'}}><Markdown testId="sample" source={supplied ?? (large ? Array.from({length:200},()=>sample).join('\n\n')+(process.env.MD_LARGE_CHECK==='1'?'\n\nEND `sentinel` reachable.':'') : sample)} theme={theme} style={{color:t.text,userSelect:'text'}} /></div>,{title:'Markdown parity',width:728,height:Number(process.env.MD_HEIGHT??800),focus:false})
