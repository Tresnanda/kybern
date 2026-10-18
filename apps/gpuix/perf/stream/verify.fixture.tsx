import '../../src/native/local-build.ts'
import {render, useGpuixRequired} from '@gpuix/react'
import {useState} from 'react'
import {emptyThreadState,type Block} from '../../../../packages/kybern-client/src/transcript.ts'
import {Transcript} from '../../src/Transcript.tsx'
import {getState,set} from '../../src/state.ts'
import {ThemeProvider,useTheme} from '../../src/ui.tsx'
import {Button} from '../../src/transcript/kit.tsx'
import {BASE,FINAL} from './verify.source.ts'

const at='2026-10-01T00:00:00Z'
const user:Block={kind:'user',id:'stream-user',turnId:'stream-turn',at,seq:1,message:{parts:[{type:'text',text:'Preserve the formatted live answer.'}]}}
const assistant:Extract<Block,{kind:'assistant'}>={kind:'assistant',id:'stream-answer',messageId:'stream-answer',segment:0,turnId:'stream-turn',at,seq:2,origin:{kind:'root'},text:BASE,thinking:'',complete:false}
const thread={id:'stream-check',status:'running',provider:{kind:'claude-code',instance:'default'},created_at:at,updated_at:at} as never
set({status:'open',selectedId:'stream-check',open:{...emptyThreadState(),loaded:true,thread,blocks:[user,assistant]}})
function Fixture(){
 const t=useTheme(),renderer=useGpuixRequired(),[final,setFinal]=useState(false)
 const append=()=>set({open:{...getState().open,blocks:[user,{...assistant,text:FINAL}]}})
 const finish=()=>{append();set({open:{...getState().open,thread:{...thread as object,status:'idle'} as never,blocks:[user,{...assistant,text:FINAL,complete:true},{kind:'turn_end',id:'end',turnId:'stream-turn',at,seq:3,terminalMessageId:'stream-answer',stopReason:'completed',durationMs:1000,costUsd:null,usage:{}} as Block]}});setFinal(true)}
 return <div testId="stream-verify" style={{display:'flex',flexDirection:'column',width:'100%',height:'100%',backgroundColor:t.surface}}>
  <div style={{display:'flex',gap:8,height:32}}><Button testId="append" onClick={append}>Append</Button><Button testId="finish" onClick={finish}>Finish</Button><Button testId="inspect" onClick={()=>{
   const api=renderer as unknown as {getMarkdownDocumentStats?:()=>unknown}; console.error('[stream-docs]',JSON.stringify(api.getMarkdownDocumentStats?.()??null))
  }}>Inspect</Button><text testId="phase" style={{color:t.text}}>{final?'Complete':'Streaming'}</text></div>
  <Transcript/>
 </div>
}
render(<ThemeProvider><Fixture/></ThemeProvider>,{title:'Streaming verification',width:1280,height:820,focus:false})
process.stdin.on('end',()=>process.exit(0))
