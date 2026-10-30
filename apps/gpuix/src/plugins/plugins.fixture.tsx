// Fixture-only: all inventories and installs stay in memory, with a scratch websocket endpoint.
import '../native/local-build.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { render } from '@gpuix/react'
import { useState } from 'react'
import { PROTOCOL_VERSION, type MachinePlugin, type PluginsNetworkView, type PluginsCopyParams } from '../../../../packages/kybern-client/src/types.ts'
import { pluginRows } from '../../../../packages/kybern-client/src/pluginSync.ts'
import type { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
import { connect, set, useApp } from '../state.ts'
import { ThemeProvider, useTheme, Label } from '../ui.tsx'
import { Button } from '../kit/Button.tsx'
import { onWindowKeyDown } from '../nav/keys.ts'
import { Plugins } from './Plugins.tsx'
import { CopyPluginSheet } from './CopyPluginSheet.tsx'
import { setPluginsFixture } from './store.ts'
const item = (id: string, extra: Partial<MachinePlugin> = {}): MachinePlugin => ({id, name: id.split('@')[0]!, provider:'claude-code',kind:'plugin',marketplace:'team-tools',source:'acme/team-tools',version:'2.1.0',enabled:true,resources:{},contents:{hooks:2,mcp_servers:1,commands:1,agents:0,skills:3,extensions:0,npm_packages:[],notes:['The agent installs the marketplace version available there. It may differ from this version.']},problem:null,fingerprint:id+'1',...extra})
const review=item('code-review@team-tools')
const deploy=item('deploy@team-tools',{contents:{hooks:0,mcp_servers:1,commands:1,agents:0,skills:2,extensions:0,npm_packages:[],notes:['Uses the target machine’s existing sign-in.']}})
const npm=item('pi-tools',{provider:'pi',marketplace:null,source:'npm:pi-tools@1.4.2',version:'1.4.2',contents:{hooks:0,mcp_servers:0,commands:0,agents:0,skills:2,extensions:1,npm_packages:['pi-tools'],notes:['Extensions can execute code, add tools and hooks.']}})
const cursor=item('design@cursor-public',{provider:'cursor',enabled:null,source:null,problem:'Cursor has no supported noninteractive plugin installer. Install in Cursor’s marketplace.'})
const VIEW: PluginsNetworkView={machines:[
 {id:'macbook',name:'MacBook',is_self:true,state:'reported',inventory:{plugins:[review,deploy,npm,cursor],warnings:["cursor: Cached plugins only; manage active installations in Cursor."],jobs:[]},detail:null},
 {id:'os-kdi',name:'os-kdi',is_self:false,state:'reported',inventory:{plugins:[{...review,version:'1.8.0',enabled:false,fingerprint:'old'}],warnings:[],jobs:[]},detail:null},
 {id:'satyamas',name:'satyamas',is_self:false,state:'reported',inventory:{plugins:[review],warnings:[],jobs:[]},detail:null},
 {id:'vps',name:'VPS',is_self:false,state:'offline',inventory:null,detail:null},
]}
let mode='page'
const fake={status:'open',call:async(method:string,params:PluginsCopyParams)=>{
 if(method==='plugins.network_view')return VIEW
 if(method==='plugins.copy')return {targets:params.to.map((target,i)=>({machine:target.machine,name:VIEW.machines.find(m=>m.id===target.machine)?.name,outbox_id:null,result:i===0?{state:'installed',message:'Installed · enabled on os-kdi',actual:review}:null,error:i===0?null:'The target harness needs an update. Update it and retry.'}))}
 return {}
},onNotification:()=>()=>{}} as unknown as KybernClient
setPluginsFixture(()=>fake)
const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(req, s) { if (s.upgrade(req)) return; return new Response('fixture') }, websocket: { message(ws, raw) {
  const request = JSON.parse(String(raw)); let result: unknown = {}
  switch (request.method) {
    case 'daemon.info': result = { protocol_version: PROTOCOL_VERSION, environment_id: 'macbook', version: 'fixture' }; break
    case 'projects.list': result = { projects: [] }; break
    case 'threads.list': result = { threads: [] }; break
    case 'tasks.list': result = { tasks: [] }; break
    case 'events.subscribe': result = { subscription_id: 'fixture', head_seq: 0, replay_ready: true }; break
  }
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }))
  set({ statusDetail: `${request.method}:${Date.now()}` })
} } })
process.env.KYBERN_URL = `ws://127.0.0.1:${server.port}/ws`
process.env.KYBERN_TOKEN = 'fixture'
if (!process.env.KYBERN_DATA_DIR) throw Error('Fixture requires an isolated data directory')
mkdirSync(process.env.KYBERN_DATA_DIR, { recursive: true })
writeFileSync(path.join(process.env.KYBERN_DATA_DIR, 'daemon.port'), String(server.port))
writeFileSync(path.join(process.env.KYBERN_DATA_DIR, 'daemon.token'), 'fixture', { mode: 0o600 })
connect()


const MODES=['page','sheet','result']
function Fixture(){
 useApp(s=>s.statusDetail)
 const t=useTheme(),[selected,choose]=useState(mode)
 return <div testId="fixture-ready" style={{display:'flex',flexDirection:'column',width:'100%',height:'100%',backgroundColor:t.surface}}>
 <div style={{display:'flex',gap:4,padding:14}}>{MODES.map(m=><Button key={m} testId={`fixture-${m}`} size="sm" variant={m===selected?'secondary':'ghost'} onClick={()=>{mode=m;choose(m)}}>{m}</Button>)}</div>
 {selected==='page'?<virtual-list testId="settings-content" style={{flexGrow:1,minHeight:0}}>
 <div key="heading" style={{display:'flex',justifyContent:'center',padding:30}}><div style={{display:'flex',flexDirection:'column',width:680,gap:9}}><Label color={t.text} size={28} weight={600}>Plugins</Label><Label color={t.textSecondary} size={14} lineHeight={22}>Your agents’ plugins and marketplaces across machines. Review what they bring, then choose where to install them.</Label></div></div>
 <Plugins inlineSheet /><div key="bottom" style={{height:40}} />
 </virtual-list>:<div style={{display:'flex',flexDirection:'column',flexGrow:1,justifyContent:'center',paddingBottom:20}}><CopyPluginSheet key={selected} inline view={VIEW} rows={pluginRows(VIEW).filter(r=>r.plugin.id===review.id)} targetId="os-kdi" close={()=>{}} /></div>}
 <Label color={t.textTertiary} size={10} style={{padding:6}}>Native fixture · all actions stay in memory</Label></div>
}
render(<ThemeProvider><Fixture /></ThemeProvider>,{title:'Plugins',width:1120,height:1080,focus:false,onKeyDown:onWindowKeyDown})
process.stdin.on('end',()=>{server.stop(true);process.exit(0)})
process.stdin.on('close',()=>{server.stop(true);process.exit(0)})
