// Harness-only controls; the rendered product is the unchanged full app.
import {existsSync,writeFileSync} from 'node:fs'
import path from 'node:path'
await import('../pacing-app.ts')
const hook=(globalThis as Record<string,unknown>).__REACT_DEVTOOLS_GLOBAL_HOOK__ as {onCommitFiberRoot:(...args:unknown[])=>void}
const previousCommit=hook.onCommitFiberRoot
hook.onCommitFiberRoot=(...args)=>{(globalThis as Record<string,unknown>).__benchFiberRoot=args[1];previousCommit(...args)}
const state=await import('../../src/state.ts')
const nav=await import('../../src/nav/store.ts')
const dock=await import('../../src/dock/store.ts')
const {showFileInExplorer}=await import('../../src/dock/explorerSelection.ts')
const {applyEvent}=await import('../../../../packages/kybern-client/src/transcript.ts')
let streamTimer:ReturnType<typeof setInterval>|undefined
const {dlopen,FFIType}=await import('bun:ffi')
const defaultWheel=path.join(process.env.KYBERN_DATA_DIR!,'bench-wheel.dylib')
const wheelLibrary=process.env.KYBERN_BENCH_WHEEL_LIBRARY??(existsSync(defaultWheel)?defaultWheel:path.resolve(process.env.KYBERN_CLIENT_CONFIG_DIR!,'../..','bench-wheel.dylib'))
const wheel=dlopen(wheelLibrary,{bench_scroll:{args:[FFIType.f64,FFIType.f64,FFIType.f64,FFIType.i32,FFIType.i32],returns:FFIType.i32}}).symbols.bench_scroll
let sequence=1000000,streamDeltas=0
const server=Bun.serve({idleTimeout:255,port:0,hostname:'127.0.0.1',async fetch(req){
 if(req.method!=='POST')return new Response('POST only',{status:405})
 const body=await req.json() as {action:string;thread?:string;file?:string;durationMs?:number;x?:number;y?:number;fling?:boolean;target?:string;delta?:number}
 try{
 if(body.action==='scroll-state'){
  const root=(globalThis as Record<string,unknown>).__benchFiberRoot as {containerInfo?:{nativeRenderer?:{getAutomationTree:()=>string;getListScrollTop:(id:number)=>number[]|null;getScrollOffset:(id:number)=>number[]|null}}}|undefined
  const renderer=root?.containerInfo?.nativeRenderer
  if(!renderer)return Response.json({offset:null})
  type Node={id:number;testId?:string;type?:string;children?:Node[]}
  const tree=JSON.parse(renderer.getAutomationTree()) as Node|Node[],stack=Array.isArray(tree)?tree:[tree]
  let target:Node|undefined,visited=0
  while(stack.length&&visited++<200000){const node=stack.pop()!;if(node.testId===body.target){target=node;break}stack.push(...node.children??[])}
  return Response.json({id:target?.id,offset:target?(renderer.getListScrollTop(target.id)??renderer.getScrollOffset(target.id)):null})
 }
 if(body.action==='counters'){
  const root=(globalThis as Record<string,unknown>).__benchFiberRoot as {current?:unknown}|undefined
  type Fiber={tag?:number;type?:string|{name?:string;type?:{name?:string}};memoizedProps?:{testId?:string};child?:Fiber;sibling?:Fiber}
  const counts:Record<string,{hostNodes:number;reactComponents:number;rowComponents:number}>={},virtualLists:Record<string,{mountedNativeRows:number}>={}
  const stack:{node:Fiber;surface:string}[]=root?.current?[{node:root.current as Fiber,surface:'shell'}]:[]
  let visited=0
  while(stack.length&&visited++<500000){const {node,surface}=stack.pop()!;const test=node.memoizedProps?.testId;const scope=test==='transcript-surface'?'transcript':test==='right-dock'?'dock':test==='thread-list'?'sidebar':surface;const c=counts[scope]??={hostNodes:0,reactComponents:0,rowComponents:0};if(typeof node.type==='string'||node.tag===6)c.hostNodes++;else if(node.type)c.reactComponents++;const name=typeof node.type==='string'?'':node.type?.name??node.type?.type?.name??'';if(name&&/Row|TurnItem/.test(name))c.rowComponents++;if(node.type==='virtual-list'&&Object.keys(virtualLists).length<64){const pending: Fiber[]=node.child?[node.child]:[];let mountedNativeRows=0,budget=500000;while(pending.length&&budget-->0){const child=pending.pop()!;if(child.sibling)pending.push(child.sibling);if(typeof child.type==='string'||child.tag===6)mountedNativeRows++;else if(child.child)pending.push(child.child)}virtualLists[test??`list-${Object.keys(virtualLists).length}`]={mountedNativeRows}};if(node.sibling)stack.push({node:node.sibling,surface});if(node.child)stack.push({node:node.child,surface:scope})}
  return Response.json({counts,virtualLists,visited,truncated:stack.length>0,builtVirtualChildrenPerFrame:null,markdownParseMs:null,textShapingMs:null,hostMutations:null,imageBytes:null,metalBytes:null,unavailable:'These counters need native instrumentation; not inferred from whole-window render time.'})
 }
 if(body.action==='wheel-probe')return Response.json({accepted:wheel(body.x!,body.y!,body.delta??0,1,0),now:performance.now()})
 if(body.action==='wheel-drive'){
  const sent:number[]=[],start=performance.now(),count=Math.floor((body.durationMs??15000)*120/1000)
  let accepted=0,lastPhase=-1
  for(let i=0;i<count&&performance.now()-start<(body.durationMs??15000);i++){
   const tick=Math.floor((performance.now()-start)*120/1000),phase=tick%300,cycle=tick%600,direction=cycle<300?-1:1
   const delta=body.fling?(phase<20?45:45*Math.exp(-(phase-20)/35)):(phase<120?6*Math.sin(Math.PI*Math.min(phase+1,30)/60):6*Math.exp(-(phase-120)/45))
   if(phase<lastPhase)wheel(body.x!,body.y!,0,0,3)
   if(phase>=120&&lastPhase<120)wheel(body.x!,body.y!,0,4,0)
   const contact=phase<120?(lastPhase<0||phase<lastPhase?1:2):0,momentum=phase>=120?(lastPhase<120?1:2):0
   lastPhase=phase
   sent.push(performance.now());accepted+=wheel(body.x!,body.y!,direction*delta,contact,momentum)
   const due=start+(i+1)*1000/120;if(due>performance.now())await Bun.sleep(due-performance.now())
  }
  wheel(body.x!,body.y!,0,lastPhase<120?4:0,lastPhase>=120?3:0)
  return Response.json({sent,accepted,productionMs:performance.now()-start,drainMs:0,maxOutstanding:0,acks:[],input:'120 Hz scheduled real AppKit NSEvent scrollWheel; precise deltas + native contact and momentum phases; direct own-window dispatch'})
 }
 if(body.action==='open'){nav.setNav({page:'home',keyboardNav:true});await state.selectThread(body.thread!)}
 if(body.action==='idle'){state.set({threads:state.getState().threads.map(t=>t.status==='running'?{...t,status:'idle'}:t)})}
 if(body.action==='home'){nav.setNav({page:'home',keyboardNav:true});await state.selectThread(null)}
 if(body.action==='explorer'){dock.setDock(state.getState().selectedId,{open:true,tabs:['explorer'],tab:'explorer',width:538,instant:true});if(body.file)showFileInExplorer(state.getState().selectedId!,state.getState().open.thread!.project_id!,body.file)}
 if(body.action==='dock-close')dock.setDock(state.getState().selectedId,{open:false,instant:true})
 if(body.action==='stream'){
  clearInterval(streamTimer)
  const id=state.getState().selectedId!,turn='bench-stream-turn',message='bench-stream-answer',started=performance.now()
  const push=(payload:Record<string,unknown>)=>state.setThreadOpen(id,applyEvent(state.getState().open,{thread_id:id,turn_id:turn,seq:++sequence,at:'2026-10-17T00:00:00Z',...payload} as never))
  push({kind:'turn_started',message_id:'bench-stream-user',message:{parts:[{type:'text',text:'Explain bounded rendering during a long answer.'}]}})
  let n=0;streamDeltas=0
  streamTimer=setInterval(()=>{
   if(performance.now()-started>(body.durationMs??60000)){clearInterval(streamTimer);push({kind:'assistant_message_completed',message_id:message,origin:{kind:'root'},text:Array.from({length:n},(_,i)=>`Streaming paragraph ${i}: preserve **formatted output** and Unicode 🌿.\n\n`).join(''),thinking:null});push({kind:'turn_completed',stop_reason:'completed',usage:{input_tokens:100,output_tokens:100},duration_ms:Math.round(performance.now()-started),terminal_message_id:message});return}
   streamDeltas=n+1
   push({kind:'assistant_text_delta',message_id:message,origin:{kind:'root'},delta:`Streaming paragraph ${n++}: preserve **formatted output** and Unicode 🌿.\n\n`})
  },40)
 }
 const s=state.getState();return Response.json({streamDeltas,selected:s.selectedId,loaded:s.open.loaded,blocks:s.open.blocks.length,nextBeforeSeq:s.open.nextBeforeSeq,firstSeq:s.open.blocks[0]?.seq,firstPromptNumber:(()=>{const numbers=s.open.blocks.flatMap(b=>{const text=b.kind==='user'?b.message.parts.flatMap(p=>p.type==='text'?[p.text]:[]).join(''):b.kind==='assistant'?b.text:'';return [...text.matchAll(/(?:Bench prompt |BENCH_RESULT_)(\d+)/g)].map(m=>Number(m[1]))});return numbers.length?Math.min(...numbers):0})(),listsLoaded:s.listsLoaded,now:performance.now()})
 }catch(e){return Response.json({error:String(e)},{status:500})}
}})
writeFileSync(path.join(process.env.KYBERN_CLIENT_CONFIG_DIR!,'bench-control.json'),JSON.stringify({port:server.port}))
process.stdin.on('end',()=>{clearInterval(streamTimer);server.stop(true);process.exit(0)})
// A forced host cancellation may bypass the runner's signal handlers.
const parent=process.ppid
setInterval(()=>{if(process.ppid!==parent)process.exit(0)},1000).unref()
export {}
