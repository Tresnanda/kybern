import '../src/native/local-build.ts'
import { render, useGpuixRequired } from '@gpuix/react'
import { useEffect, useState } from 'react'
import { createMarkdownDocument, updateMarkdownDocument, releaseMarkdownDocument, getMarkdownDocumentText, getMarkdownDocumentStats, getMarkdownDocumentLayout, MarkdownRange, type MarkdownDocument } from '../src/native/markdownDocument.tsx'
import { markdownTheme } from '../src/transcript/kit.tsx'
import { THEMES } from '../src/theme.ts'
const t=THEMES[process.env.KYBERN_APPEARANCE==='light'?'light':'dark']
function App() {
 const renderer=useGpuixRequired()
 const [result,setResult]=useState(''),[document,setDocument]=useState<MarkdownDocument|null>(null)
 useEffect(()=> {
  let live=true;let shown:MarkdownDocument|undefined
  const run=async()=> {
   const before=getMarkdownDocumentStats(renderer)
   const source=Array.from({length:100},(_,i)=>`## Section ${i}\n\nParagraph **${i}** 😀é with [global][ref].\n\n`).join('')
   let doc=await createMarkdownDocument(renderer,{text:source})
   const first=doc
   const suffix=source+'a final paragraph'
   doc=await updateMarkdownDocument(renderer,doc.id,{text:suffix,expectedRevision:doc.revision})
   const stable=doc.stablePrefixBlocks,bytes=doc.parsedBytes
   const prefixIds=first.blocks.slice(0,stable).every((block,i)=>block.id===doc.blocks[i]?.id)
   const textExact=getMarkdownDocumentText(renderer,doc)===suffix
   let stale=false;try{await updateMarkdownDocument(renderer,doc.id,{text:'stale',expectedRevision:1})}catch{stale=true}
   const referenced=suffix+'\n\n[ref]: https://example.com/global'
   doc=await updateMarkdownDocument(renderer,doc.id,{text:referenced,expectedRevision:doc.revision})
   const fullInvalidation=doc.stablePrefixBlocks===0&&doc.parsedBytes===Buffer.byteLength(referenced)
   const cold=await createMarkdownDocument(renderer,{text:referenced})
   const sameBlocks=JSON.stringify(doc.blocks.map(({id,...block})=>block))===JSON.stringify(cold.blocks.map(({id,...block})=>block))
   releaseMarkdownDocument(renderer,cold.id)
   const noop=await updateMarkdownDocument(renderer,doc.id,{text:referenced,expectedRevision:doc.revision})
   const noParse=noop.parsedBytes===0&&noop.stablePrefixBlocks===noop.blocks.length
   const pending=updateMarkdownDocument(renderer,doc.id,{text:'paragraph '.repeat(150000),expectedRevision:noop.revision})
   releaseMarkdownDocument(renderer,doc.id)
   let cancelled=false;try{await pending}catch{cancelled=true}
   let released=false;try{getMarkdownDocumentText(renderer,noop)}catch{released=true}
   let sizeLimit=false;try{await createMarkdownDocument(renderer,{text:'x'.repeat(2*1024*1024+1)})}catch{sizeLimit=true}
   for(let i=0;i<100&&getMarkdownDocumentStats(renderer).pending;i++)await Bun.sleep(10)
   const handles:MarkdownDocument[]=[]
   for(let i=0;i<32;i++)handles.push(await createMarkdownDocument(renderer,{text:''}))
   let documentLimit=false;try{await createMarkdownDocument(renderer,{text:''})}catch{documentLimit=true}
   for(const handle of handles)releaseMarkdownDocument(renderer,handle.id)
   handles.length=0
   for(let i=0;i<8;i++)handles.push(await createMarkdownDocument(renderer,{text:'a'.repeat(2*1024*1024)}))
   let aggregateLimit=false;try{await createMarkdownDocument(renderer,{text:'a'})}catch{aggregateLimit=true}
   for(const handle of handles)releaseMarkdownDocument(renderer,handle.id)
   const tasks=Array.from({length:8},()=>createMarkdownDocument(renderer,{text:'queued'}))
   let queueLimit=false;try{await createMarkdownDocument(renderer,{text:'ninth'})}catch{queueLimit=true}
   for(const handle of await Promise.all(tasks))releaseMarkdownDocument(renderer,handle.id)
   for(let i=0;i<100&&getMarkdownDocumentStats(renderer).pending;i++)await Bun.sleep(10)
   const after=getMarkdownDocumentStats(renderer)
   shown=await createMarkdownDocument(renderer,{text:referenced})
   if(live) {setDocument(shown);setResult(JSON.stringify({before,after,stable,bytes,prefixIds,textExact,stale,fullInvalidation,sameBlocks,noParse,cancelled,released,sizeLimit,documentLimit,aggregateLimit,queueLimit}))}
   else releaseMarkdownDocument(renderer,shown.id)
  }
  void run().catch(error=>setResult(JSON.stringify({error:String(error)})))
  return()=>{live=false;if(shown)releaseMarkdownDocument(renderer,shown.id)}
 },[renderer])
 return <div testId="api-ready" onKeyDown={e=>{if(e.key==='l'&&document)setResult(JSON.stringify(getMarkdownDocumentLayout(renderer,document)));if(e.key==='n'&&document)void updateMarkdownDocument(renderer,document.id,{text:getMarkdownDocumentText(renderer,document),expectedRevision:document.revision}).then(next=>{setDocument(next);setResult(JSON.stringify({noopRevision:next.revision}))})}} style={{width:'100%',height:'100%',display:'flex',flexDirection:'column',backgroundColor:t.surface,padding:20}}>
  <text testId="api-result" style={{color:t.text,fontSize:10,height:40}}>{result}</text>
  <virtual-list testId="api-scroll" style={{flexGrow:1,minHeight:0}}><div>{document&&<MarkdownRange document={document.id} revision={document.revision} theme={markdownTheme(t)} />}</div></virtual-list>
 </div>
}
render(<App/>,{title:'Markdown documents',width:728,height:800,focus:false})
