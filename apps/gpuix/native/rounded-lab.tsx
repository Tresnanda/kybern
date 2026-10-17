import '../src/native/local-build.ts'
import { render, useGpuixRequired } from '@gpuix/react'
import { useState } from 'react'
import { DecoratedTextarea } from '../src/native/decorated-input.tsx'
import { nativeCapabilities, decoratedInputCapabilities, type InputDecoration } from '../src/native/api.ts'
import { THEMES } from '../src/theme.ts'
const light = process.env.KYBERN_APPEARANCE === 'light', t = THEMES[light ? 'light' : 'dark']
const bg = light ? '#ffffff' : '#202024', pill = light ? '#add4fc' : '#28517c'
const cases = [
  ['radius', '  @Computer  ', [[2, 11]], 420],
  ['touching', '@One@TwoX', [[0, 4], [4, 8]], 420],
  ['gaps', 'X  @One  @Two  X', [[3, 7], [9, 13]], 420],
  ['edges', '@Computer', [[0, 9]], 108.4],
  ['wrap', '@LongReferenceThatWrapsAcrossSeveralLines', [[0, 41]], 145],
] as const
function Lab() {
 const renderer = useGpuixRequired(), api = nativeCapabilities(renderer), rich = decoratedInputCapabilities(renderer)
 const [radius, setRadius] = useState(5), [outset, setOutset] = useState(4), [result,setResult] = useState('')
 const id = (name: string): number => { const tree=JSON.parse((renderer as any).getAutomationTree());const find=(n:any):any=>n.testId===name||n.props?.testId===name?n.id:n.children?.map(find).find((v:any)=>v!=null);return Array.isArray(tree)?tree.map(find).find((v:any)=>v!=null):find(tree) }
 const button=(name:string,fn:()=>unknown)=><div testId={name} onClick={()=>{try{setResult(JSON.stringify(fn())??'ok')}catch(e){setResult(String(e))}}} style={{width:110,height:26,backgroundColor:t.buttonSecondary}}><text style={{color:t.text}}>{name}</text></div>
 return <div testId="ready" style={{width:'100%',height:'100%',padding:24,display:'flex',flexDirection:'column',gap:12,backgroundColor:bg}}>
 <text style={{color:t.text,fontSize:20}}>{`Native inline backgrounds · ${light?'Light':'Dark'}`}</text>
 <text style={{color:t.textSecondary}}>Tauri composer: accent-blue · weight 500 · radius .25em · no background/padding</text>
 <div style={{display:'flex',gap:24}}><DecoratedTextarea testId="reference" value="Use @Computer now" decorations={[{start:4,end:13,atomic:true,style:{color:t.accentBlue,fontWeight:500}}]} style={{width:260,height:32,color:t.text,fontSize:16}}/><text style={{color:t.accentBlue,fontWeight:500,fontSize:16}}>Expected: @Computer</text></div>
 <text style={{color:t.textSecondary}}>Capability stress colors below. Radius 5px; outset 4px (visual only).</text>
 {cases.map(([name,value,ranges,width])=><div key={name} style={{display:'flex',gap:24,alignItems:'center'}}>
 <div style={{width:440}}><DecoratedTextarea testId={name} value={value} decorations={ranges.map(([start,end],index)=>({start,end,id:`${name}-${index}`,atomic:true,style:{backgroundColor:pill,borderRadius:radius,backgroundOutsetX:outset}}))} minRows={name==='wrap'?4:1} maxRows={6} style={{width,height:name==='wrap'?110:32,fontFamily:'Menlo',fontSize:20,lineHeight:24,color:t.text}}/></div>
 <text style={{color:t.textSecondary}}>{name}</text></div>)}
 <text style={{color:t.textSecondary}}>Notes code: radius 5px · foreground 4% light / 5% dark; layout padding remains unsupported</text>
 <DecoratedTextarea testId="notes-code" value="A `code` example" decorations={[{start:3,end:7,style:{backgroundColor:light?'rgba(13,13,13,0.04)':'rgba(252,252,252,0.05)',borderRadius:5}}]} style={{width:420,height:32,fontSize:16,color:t.text}}/>
 <div style={{display:'flex',gap:8}}>{button('rect',()=>setRadius(0))}{button('round',()=>setRadius(5))}{button('huge',()=>setOutset(1000))}{button('zero',()=>setOutset(0))}{button('normal',()=>setOutset(4))}</div>
 <div style={{display:'flex',gap:8}}>{button('select',()=>api.setInputSelection(id('radius'),2,11,false))}{button('before',()=>api.setInputSelection(id('radius'),2,2,false))}{button('selection',()=>api.getInputSelection(id('radius')))}{button('invalid',()=>rich.setInputDecorations(id('radius'),[{start:2,end:11,style:{borderRadius:-1}}],cases[0][1]))}{button('padding',()=>rich.setInputDecorations(id('radius'),[{start:2,end:11,style:{paddingX:1} as any}],cases[0][1]))}</div>
 <text testId="result" style={{color:t.text}}>{result}</text>
 </div>
}
render(<Lab/>,{title:'Rounded input backgrounds',width:840,height:750,focus:false})
