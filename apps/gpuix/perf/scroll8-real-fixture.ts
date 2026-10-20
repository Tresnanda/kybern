/** Real daemon PR reads behind a strict three-method allowlist. All boot state
 * and preference writes stay in the disposable fixture, never ~/.kybern. */
import {readFileSync} from 'node:fs'
import {homedir} from 'node:os'
import path from 'node:path'
import {KybernClient} from '../../../packages/kybern-client/src/client.ts'
import {actionFixture} from '../src/pulls/verify.fixture.ts'
export async function readOnlyPrFixture(){
 const fallback=actionFixture({long:true}),base=path.join(homedir(),'.kybern')
 const real=new KybernClient({url:`ws://127.0.0.1:${readFileSync(path.join(base,'daemon.port'),'utf8').trim()}/ws`,token:readFileSync(path.join(base,'daemon.token'),'utf8').trim()})
 const local=new KybernClient({url:fallback.env.KYBERN_URL,token:fallback.env.KYBERN_TOKEN})
 real.connect();local.connect()
 const deadline=Date.now()+30000
 while(real.status!=='open'||local.status!=='open'){if(Date.now()>deadline)throw Error('Read-only proxy connection timed out');await Bun.sleep(20)}
 const project=(await real.call('projects.list',{})).projects.find(p=>p.path==='/Users/mymac/projects/ade')
 if(!project)throw Error('Real ade project missing')
 const allowed=new Set(['github.pr.list','github.pr.detail','github.pr.page'])
 const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(req,server){
  const headers={'access-control-allow-origin':req.headers.get('origin')??'*','access-control-allow-headers':'authorization,content-type','access-control-allow-methods':'POST,OPTIONS','vary':'Origin'}
  if(new URL(req.url).pathname==='/session'){
   if(req.method==='OPTIONS')return new Response(null,{headers})
   if(req.method==='POST'&&req.headers.get('authorization')==='Bearer local-fixture')return Response.json({ticket:'fixture-ticket'},{headers})
   return new Response('Unauthorized',{status:401,headers})
  }
  if(server.upgrade(req))return;return new Response('Not found',{status:404})
 },websocket:{async message(ws,raw){
  const message=JSON.parse(String(raw))
  try{
   if(message.method.startsWith('github.')&&!allowed.has(message.method))throw Error('Read-only proxy rejects this method')
   const result=allowed.has(message.method)?await real.call(message.method,{...message.params,project_id:project.id}):await local.call(message.method,message.params)
   ws.send(JSON.stringify({jsonrpc:'2.0',id:message.id,result}))
  }catch(error){ws.send(JSON.stringify({jsonrpc:'2.0',id:message.id,error:{code:-32000,message:String(error)}}))}
 }}})
 return{env:{...fallback.env,KYBERN_URL:`ws://127.0.0.1:${server.port}/ws`},close(){server.stop(true);real.close();local.close();fallback.close()}}
}
