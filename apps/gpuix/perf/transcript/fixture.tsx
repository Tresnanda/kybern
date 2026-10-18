import '../../src/native/local-build.ts'
import { assertScratchEnv } from '../../src/requests/harness.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { Profiler } from 'react'
import { render, useGpuixRequired } from '@gpuix/react'
import { emptyThreadState, type Block } from '../../../../packages/kybern-client/src/transcript.ts'
import { getState, set } from '../../src/state.ts'
import { Transcript } from '../../src/Transcript.tsx'
import { gradientPng } from '../../visual/fixture.ts'
import { nativeCapabilities } from '../../src/native/api.ts'
import { ThemeProvider, useTheme } from '../../src/ui.tsx'
assertScratchEnv(process.env)
mkdirSync(process.env.KYBERN_CLIENT_CONFIG_DIR!,{recursive:true})
const n = Number(process.env.TRANSCRIPT_TURNS ?? 1000)
const at = '2026-10-01T00:00:00Z'
const thread = { id:'perf-transcript', title:'Synthetic transcript', status:'idle', provider:{kind:'claude-code',instance:'default'}, created_at:at, updated_at:at } as never
const image = gradientPng(640,360).toString('base64')
const blocks: Block[] = []
for(let i=0;i<n;i++) {
 const turnId=`turn-${i}`, id=`answer-${i}`
 blocks.push({kind:'user',id:`user-${i}`,turnId,at,seq:i*3+1,message:{parts:[{type:'text',text:`Prompt ${i}: review bounded rendering and preserve reading position.`},...(i%100===0?[{type:'image' as const,media_type:'image/png',data:image}]:[])]}},
 ...(i%100===0?[{kind:'image' as const,id:`image-${i}`,turnId,at,seq:i*3+1.25,source:`data:image/png;base64,${image}`}]:[]),
 {kind:'tool',id:`tool-${i}`,turnId,at,seq:i*3+1.5,origin:{kind:'root'},call:{id:`call-${i}`,name:'Read',input:{file_path:'src/view.ts'}},stream:'',output:{text:'@@ -1 +1 @@\n-old()\n+stable()'},isError:false,complete:true},
 {kind:'assistant',id,messageId:id,segment:0,turnId,at,seq:i*3+2,origin:{kind:'root'},complete:true,thinking:'',text:`## Result ${i}\n\nPreserve **formatted output**, *selection*, and Unicode 🌿.\n\n| Stage | Status |\n| --- | --- |\n| Paint | Complete |\n\n> Keep the reading position.\n\n\`\`\`typescript\n${Array.from({length:i%10===0?160:12},(_,j)=>`export const row${j} = { key: ${j}, text: "Stable syntax" };`).join('\n')}\n\`\`\`\n\n\`\`\`diff\n@@ -1 +1 @@\n-old()\n+stable()\n\`\`\`\n\nBENCH_RESULT_${i}`},
 {kind:'turn_end',id:`end-${i}`,turnId,at,seq:i*3+3,stopReason:'completed',durationMs:1000,error:null,terminalMessageId:id,costUsd:null,usage:{input_tokens:0,output_tokens:0,cache_read_tokens:0,cache_write_tokens:0}})
}
let streamTimer: ReturnType<typeof setInterval> | undefined
if(process.env.TRANSCRIPT_STREAM==='1') {
 const user: Block = {kind:'user',id:'live-user',turnId:'live-turn',seq:999999,at,message:{parts:[{type:'text',text:'Continue the live analysis.'}]}}
 const answer: Extract<Block,{kind:'assistant'}> = {kind:'assistant',id:'live-answer',messageId:'live-answer',segment:0,turnId:'live-turn',seq:1000000,at,origin:{kind:'root'},complete:false,thinking:'',text:'Live **formatted** answer.'}
 blocks.push(user, answer)
 ;(thread as {status:string}).status='running'
 let n=0
 streamTimer=setInterval(()=>{const text=answer.text+Array.from({length:++n},(_,i)=>` Word ${i}: preserve **formatting** and Unicode 🌿.`).join('');set({open:{...getState().open,blocks:[...blocks.slice(0,-1),{...answer,text}]}})},80)
}
if(process.env.TRANSCRIPT_COMPACT==='1'){const compact=blocks.filter(b=>b.kind!=='tool'&&b.kind!=='image').map(b=>b.kind==='assistant'?{...b,text:`Compact answer ${b.turnId}.`}:b.kind==='user'?{...b,message:{parts:b.message.parts.filter(p=>p.type==='text')}}:b);blocks.splice(0,blocks.length,...compact)}
set({status:'open',selectedId:'perf-transcript',open:{...emptyThreadState(),thread,loaded:true,blocks}})
let rootId:number|null=null
let renderer:ReturnType<typeof useGpuixRequired>
function Fixture(){ renderer=useGpuixRequired();const t=useTheme();return <div ref={node=>{rootId=node?.id??null}} testId="perf-ready" style={{display:'flex',flexDirection:'column',width:'100%',height:'100%',backgroundColor:t.surface}}><Profiler id="transcript" onRender={(_id,phase,actual)=>console.error(`[transcript-render] phase=${phase} actualMs=${actual.toFixed(3)}`)}><Transcript /></Profiler></div> }
const server=Bun.serve({idleTimeout:255,port:0,hostname:'127.0.0.1',async fetch(req){const b=await req.json() as {action:string;index?:number;durationMs?:number;x:number;y:number;fling?:boolean;allPackets?:boolean};
 if(b.action==='wheel-drive')return Response.json(await (await import('./appkit.ts')).driveNative(b))
 if(b.action==='state')return Response.json({bounds:rootId&&renderer?.getElementBounds?.(rootId)})
 if(b.action==='selected')return Response.json({selected:renderer.getSelectedText?.()})
 const tree=JSON.parse((renderer as unknown as {getAutomationTree(): string}).getAutomationTree()) as {elements:Record<string,unknown>[]}
 if(b.action==='select'){const all:any[]=[];const walk=(e:any)=>{all.push(e);for(const c of e.children??[])walk(c)};walk(tree);const code=all.find(e=>(e.type==='code'||e.type==='markdown')&&(e.bounds?.y??-1)>=0&&(e.bounds?.y??900)<800&&(e.bounds?.height??0)>0);if(!code)throw Error('No painted code');nativeCapabilities(renderer).setTextSelection(code.id,0,0,4);return Response.json({selected:renderer.getSelectedText?.(),id:code.id})}
 if(b.action==='selected')return Response.json({selected:renderer.getSelectedText?.()})
 if(b.action==='jump'||b.action==='where'){const find=(e:any):any=>e.type==='virtual-list'?e:(e.children??[]).map(find).find(Boolean);const list=find(tree);if(b.action==='jump')renderer.scrollToItem?.(list.id,b.index!);const ids:string[]=[];const visit=(e:any)=>{if(e.testId?.startsWith('message-jump-'))ids.push(e.testId);for(const c of e.children??[])visit(c)};visit(tree);return Response.json({anchor:renderer.getListScrollTop?.(list.id),list:list.id,rail:ids})}
 return Response.json(tree)
}})
writeFileSync(process.env.KYBERN_CLIENT_CONFIG_DIR!+'/transcript-control.json',JSON.stringify({port:server.port,pid:process.pid}))
if(process.env.TRANSCRIPT_HEADLESS==='1') {
 const {createRequire}=await import('node:module');const {pathToFileURL}=await import('node:url');const path=await import('node:path')
 const entry=createRequire(import.meta.url).resolve('@gpuix/react')
 const {createRoot,flushSync}=await import(pathToFileURL(path.join(path.dirname(entry),'reconciler/reconciler.js')).href)
 const hosts=new Map<number,{type:string;props?:unknown}>()
 const fake={applyBatch(json:string){for(const [op,id,value] of JSON.parse(json)){if(op==='createElement')hosts.set(id,{type:value});if(op==='destroyElement')hosts.delete(id)}return []},setWindowKeyEvents(){},setWindowSelectionChange(){},addLayoutObserver(){return 1},removeLayoutObserver(){},isLayoutObserverActive(){return true},getListScrollTop(){return [0,0]}}
 const root=createRoot(fake);flushSync(()=>root.render(<ThemeProvider><Fixture /></ThemeProvider>));await Bun.sleep(50)
 const counts:Record<string,number>={};for(const h of hosts.values())counts[h.type]=(counts[h.type]??0)+1
 console.log(JSON.stringify({count:n,hosts:hosts.size,types:counts,headless:true,nativeFootprintMeasured:false}));root.unmount();server.stop(true);process.exit(0)
} else render(<ThemeProvider><Fixture /></ThemeProvider>,{title:'Transcript performance',width:1280,height:820,focus:false})
if(process.env.TRANSCRIPT_HEADLESS!=='1'){
 const {each,getObjc,nsApp,sel}=await import('../../src/native/objc.ts');const o=getObjc(),app=nsApp();if(app)each(o,o.msg(app,sel(o,'windows')) as never,window=>{o.msgSetI64(window,sel(o,'setLevel:'),3n);o.msgSetBool(window,sel(o,'setIgnoresMouseEvents:'),true);o.msg(window,sel(o,'orderFrontRegardless'))})
}
process.stdin.on('end',()=>{clearInterval(streamTimer);server.stop(true);process.exit(0)})
process.stdin.on('close',()=>process.exit(0))
