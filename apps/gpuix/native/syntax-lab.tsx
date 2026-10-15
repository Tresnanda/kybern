import '../src/native/local-build.ts'
import { render, useGpuixRequired } from '@gpuix/react'
import { useEffect, useState } from 'react'
import { createSyntaxDocument, VirtualCode, releaseSyntaxDocument, updateSyntaxDocument, getSyntaxDocumentText, type SyntaxDocument } from '../src/native/syntax.tsx'
const source=process.env.SYNTAX_LARGE==='1'?'/*\n'+'line 😀\n'.repeat(70000)+'*/\nconst end = 1;':process.env.SYNTAX_SOURCE??'/* start\n😀 comment\nend */\nconst x = "é";\n'
const language=process.env.SYNTAX_LANGUAGE??'typescript'
const light=process.env.KYBERN_APPEARANCE==='light'
const split=Number(process.env.SYNTAX_SPLIT??-1)
function Lab(){
 const renderer=useGpuixRequired()
 const [doc,setDoc]=useState<SyntaxDocument|null>(null),[result,setResult]=useState(''),[revisionKey,setKey]=useState(0)
 useEffect(()=>{let live=true;let handle:SyntaxDocument|undefined;createSyntaxDocument(renderer,{text:source,language}).then(d=>{handle=d;if(live)setDoc(d);else releaseSyntaxDocument(renderer,d.id)}).catch(e=>setResult(String(e)));return()=>{live=false;if(handle)releaseSyntaxDocument(renderer,handle.id)}},[renderer])
 const action=async(key:string)=>{
  if(key==='i'){setResult(JSON.stringify((renderer as unknown as {getSyntaxDocumentStats():object}).getSyntaxDocumentStats()));return}
  if(!doc)return;try{
  if(key==='u'){const next=await updateSyntaxDocument(renderer,doc.id,{expectedRevision:doc.revision,text:'// edited before range\n'+source});setDoc(next);setResult('updated')}
  else if(key==='s'){await updateSyntaxDocument(renderer,doc.id,{expectedRevision:0,text:'stale'});setResult('bad')}
  else if(key==='c'){const one=updateSyntaxDocument(renderer,doc.id,{expectedRevision:doc.revision,text:'/*\n'+source});const two=updateSyntaxDocument(renderer,doc.id,{expectedRevision:doc.revision+1,text:source});const results=await Promise.allSettled([one,two]);if(results[0].status!=='rejected'||results[1].status!=='fulfilled')throw Error('stale work was adopted');setDoc(results[1].value);setResult('cancelled stale result')}
  else if(key==='r'){releaseSyntaxDocument(renderer,doc.id);setResult('released')}
  else if(key==='t')setResult(getSyntaxDocumentText(renderer,doc))
  else if(key==='g')setResult(JSON.stringify({text:renderer.getSelectedText?.(),ranges:(renderer as unknown as {getTextSelection():unknown}).getTextSelection()}))
  else if(key==='m')setKey(n=>n+1)
  else if(key==='a'){
   const handles:SyntaxDocument[]=[]
   try {
    for(let i=0;i<31;i++)handles.push(await createSyntaxDocument(renderer,{text:`const value = ${i}`,language:'typescript'}))
    let rejected=false;try{await createSyntaxDocument(renderer,{text:'overflow'})}catch{rejected=true}
    if(!rejected)throw Error('Document bound not enforced')
   }finally{for(const h of handles)releaseSyntaxDocument(renderer,h.id)}
   setResult('document bound enforced')
  }
  else if(key==='p'){
   const pending:Array<Promise<SyntaxDocument>>=[]
   let rejected=false
   for(let i=0;i<9;i++){try{pending.push(createSyntaxDocument(renderer,{text:'/* comment */\n'.repeat(20000),language:'typescript'}))}catch{rejected=true}}
   const outcomes=await Promise.allSettled(pending)
   for(const result of outcomes)if(result.status==='fulfilled')releaseSyntaxDocument(renderer,result.value.id)
   if(!rejected)throw Error('Queue bound not enforced')
   setResult('queue bound enforced')
  }
  else if(key==='x'){
   const pending=updateSyntaxDocument(renderer,doc.id,{expectedRevision:doc.revision,text:'/* comment */\n'.repeat(20000)})
   releaseSyntaxDocument(renderer,doc.id)
   const result=await Promise.allSettled([pending]);if(result[0].status!=='rejected')throw Error('Released work published')
   setDoc(null);setResult('released parse cancelled')
  }
 }catch(e){setResult(String(e))}}
 const style={width:500,minWidth:0,fontSize:14,lineHeight:20,fontFamily:'Menlo',color:light?'#242424':'#eeeeee'}
 return <div testId="app-ready" onKeyDown={e=>{void action(e.key??'')}} style={{width:'100%',height:'100%',padding:20,backgroundColor:light?'#f5f5f5':'#202020',display:'flex',flexDirection:'column'}}>
 {doc&&<div key={revisionKey} testId="ready" style={{width:500,display:'flex',flexDirection:'column'}}>{process.env.SYNTAX_START?<VirtualCode document={doc.id} revision={doc.revision} startLine={Number(process.env.SYNTAX_START)} endLine={Number(process.env.SYNTAX_END)} showLineNumbers theme={{appearance:light?'light':'dark'}} style={style}/>:split<0?<code code={source} language={language} showLineNumbers softWrap={process.env.SYNTAX_WRAP==='1'} theme={{appearance:light?'light':'dark'}} style={style}/>:<>
 <VirtualCode document={doc.id} revision={doc.revision} startLine={0} endLine={split} showLineNumbers softWrap={process.env.SYNTAX_WRAP==='1'} theme={{appearance:light?'light':'dark'}} style={style}/>
 <VirtualCode document={doc.id} revision={doc.revision} startLine={split} endLine={doc.lineCount} showLineNumbers softWrap={process.env.SYNTAX_WRAP==='1'} theme={{appearance:light?'light':'dark'}} style={style}/>
 </>}</div>}
 <text testId="result" style={{color:light?'#242424':'#eeeeee',fontSize:10}}>{result}</text>
 </div>
}
render(<Lab/>,{title:'Native whole-document syntax',width:560,height:500,focus:false})
