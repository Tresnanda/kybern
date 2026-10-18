import '../../src/native/local-build.ts'
import {mkdirSync,writeFileSync} from 'node:fs'
import {useCallback,useState} from 'react'
import {render,useGpuixRequired,type PublicInstance} from '@gpuix/react'
import {assertScratchEnv} from '../../src/requests/harness.ts'
import {SidebarWindow,type SidebarWindowEntry} from '../../src/sidebar/Window.tsx'
import {ThemeProvider,useTheme} from '../../src/ui.tsx'
assertScratchEnv(process.env)
const data=process.env.KYBERN_CLIENT_CONFIG_DIR!;mkdirSync(data,{recursive:true})
const size=Number(process.env.TRANSCRIPT_TURNS??30000)
let renderer:ReturnType<typeof useGpuixRequired>,root:PublicInstance|null=null,list:PublicInstance|null=null
let update:(kind:string)=>void
function Fixture(){
 renderer=useGpuixRequired();const theme=useTheme()
 const [box,setBox]=useState<PublicInstance|null>(null),[node,setList]=useState<PublicInstance|null>(null)
 const [keys,setKeys]=useState(()=>Array.from({length:size},(_,i)=>`row-${i}`))
 list=node
 const attach=useCallback((n:PublicInstance|null)=>{root=n;setBox(n)},[])
 update=kind=>setKeys(old=>kind==='prepend'?[...Array.from({length:50},(_,i)=>`older-${i}`),...old]:kind==='reverse'?[...old].reverse():old)
 const entries:SidebarWindowEntry[]=keys.map(key=>({key,pinned:key==='row-0'||key==='row-29999'||(process.env.SCROLL2_FOCUS_PROBE==='1'&&key==='row-15000'),height:Number(key.split('-').at(-1))%10===0?55:30,render:()=> <div testId={key} style={{height:Number(key.split('-').at(-1))%10===0?55:30,width:'100%',paddingLeft:12,display:'flex',alignItems:'center'}}><text style={{color:theme.text}}>{`Prompt ${key}: stable measured list`}</text>{process.env.SCROLL2_FOCUS_PROBE==='1'&&key==='row-15000'&&<input testId="sparse-initial-focus" value="Stable focus" style={{width:180,height:24}}/>}</div>}))
 return <div ref={attach} testId="perf-ready" style={{display:'flex',flexDirection:'column',height:'100%',width:'100%',backgroundColor:theme.surface}}><SidebarWindow entries={entries} list={node} box={box} setList={setList}/></div>
}
const server=Bun.serve({port:0,hostname:'127.0.0.1',async fetch(req){const b=await req.json() as {action:string;index?:number;durationMs?:number;x:number;y:number;fling?:boolean;allPackets?:boolean}
 if(b.action==='wheel-drive')return Response.json(await(await import('../transcript/appkit.ts')).driveNative(b))
 if(b.action==='state')return Response.json({bounds:root&&renderer.getElementBounds?.(root.id)})
 if(b.action==='jump'&&list)renderer.scrollToItem?.(list.id,b.index!)
 if(b.action==='prepend'||b.action==='reverse')update(b.action)
 return Response.json({anchor:list&&renderer.getListScrollTop?.(list.id)})
}})
writeFileSync(data+'/transcript-control.json',JSON.stringify({port:server.port,pid:process.pid}))
render(<ThemeProvider><Fixture/></ThemeProvider>,{title:'Sparse list performance',width:1280,height:820,focus:false})
const {each,getObjc,nsApp,sel}=await import('../../src/native/objc.ts');const o=getObjc(),app=nsApp();if(app)each(o,o.msg(app,sel(o,'windows')) as never,w=>{o.msgSetI64(w,sel(o,'setLevel:'),3n);o.msgSetBool(w,sel(o,'setIgnoresMouseEvents:'),true);o.msg(w,sel(o,'orderFrontRegardless'))})
process.stdin.on('end',()=>{server.stop(true);process.exit(0)});process.stdin.on('close',()=>process.exit(0))
