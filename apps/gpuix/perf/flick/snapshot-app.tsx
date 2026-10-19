import '../../src/native/local-build.ts'
import {render,useGpuixRequired} from '@gpuix/react'
import {useState} from 'react'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import path from 'node:path'
import {mkdirSync,writeFileSync} from 'node:fs'
import {assertScratchEnv} from '../../src/requests/harness.ts'
assertScratchEnv(process.env)
const entry=createRequire(import.meta.url).resolve('@gpuix/react')
const {flushSync}=await import(pathToFileURL(path.join(path.dirname(entry),'reconciler/reconciler.js')).href)
let renderer:ReturnType<typeof useGpuixRequired>,movingId=0,setMoved:(next:boolean)=>void
function Fixture(){
 renderer=useGpuixRequired();const[moved,move]=useState(false);setMoved=move
 return <div testId="snapshot-ready" style={{display:'flex',width:'100%',height:'100%',position:'relative',backgroundColor:'#ffffff'}}><div ref={node=>{movingId=node?.id??0}} testId="snapshot-moving" style={{position:'absolute',left:moved?120:10,top:20,width:80,height:30,backgroundColor:'#2475ca'}}><text style={{color:'#ffffff'}}>Bounds</text></div></div>
}
const server=Bun.serve({port:0,hostname:'127.0.0.1',async fetch(req){
 const {moved}=await req.json() as {moved:boolean}
 flushSync(()=>setMoved(moved))
 const before=renderer.getElementBounds?.(movingId)
 const tree=JSON.parse((renderer as unknown as {getAutomationTree:()=>string}).getAutomationTree())
 const after=renderer.getElementBounds?.(movingId)
 return Response.json({before,tree,after})
}})
mkdirSync(process.env.KYBERN_CLIENT_CONFIG_DIR!,{recursive:true})
writeFileSync(path.join(process.env.KYBERN_CLIENT_CONFIG_DIR!,'snapshot-control.json'),JSON.stringify({port:server.port}))
render(<Fixture/>,{title:'Synchronous geometry snapshot',width:400,height:180,focus:false})
process.stdin.on('end',()=>{server.stop(true);process.exit(0)})
