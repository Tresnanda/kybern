/** Own a fresh daemon and deterministic eight-turn transcript for any verification command.
 * bun scripts/combined-fixture.ts -- bun scripts/combined-perf.ts
 * Requires the checkout's existing target/debug/kybernd; never builds or uses ~/.kybern.
 */
import {mkdtempSync,mkdirSync,readFileSync,existsSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {spawn} from 'node:child_process'
import {Database} from 'bun:sqlite'
import {KybernClient} from '../../../packages/kybern-client/src/client.ts'
const root=path.resolve(import.meta.dir,'../../..'),bin=path.join(root,'target/debug/kybernd')
if(!existsSync(bin))throw Error('Build this checkout’s kybernd first, with its own CARGO_TARGET_DIR')
const args=process.argv.slice(2).filter((arg,index)=>index!==0||arg!=='--')
if(!args.length)throw Error('Pass a verification command')
const scratch=mkdtempSync(path.join(tmpdir(),'gpuix-scratch-combined-')),data=path.join(scratch,'data')
mkdirSync(data);mkdirSync(path.join(scratch,'project'))
const daemon=spawn(bin,['--data-dir',data,'--port','0'],{stdio:'ignore'})
let client:KybernClient|undefined
let child:ReturnType<typeof Bun.spawn>|undefined
try {
 const deadline=Date.now()+30000
 while(!existsSync(path.join(data,'daemon.port'))) {if(Date.now()>deadline||daemon.exitCode!==null)throw Error('Scratch daemon failed');await Bun.sleep(30)}
 const port=readFileSync(path.join(data,'daemon.port'),'utf8').trim()
 if(port==='4219'||port==='0')throw Error('Invalid scratch port')
 client=new KybernClient({url:`ws://127.0.0.1:${port}/ws`,token:readFileSync(path.join(data,'daemon.token'),'utf8').trim()});client.connect()
 while(client.status!=='open'){if(Date.now()>deadline)throw Error('Scratch connection failed');await Bun.sleep(30)}
 const project=await client.call('projects.add',{path:path.join(scratch,'project'),name:'scratch-project'})
 const thread=await client.call('threads.create',{project_id:project.id,title:'Combined verification',provider:{kind:'claude-code',instance:'default'},model:'claude-haiku-5-5'})
 const db=new Database(path.join(data,'state.sqlite'))
 try {
  db.transaction(()=>{
   const insert=db.query('INSERT INTO events(thread_id,turn_id,at,kind,payload) VALUES (?,?,?,?,?)')
   for(let i=0;i<8;i++){
    const turn=crypto.randomUUID(),message=crypto.randomUUID(),tool=crypto.randomUUID()
    const events=[
     {kind:'turn_started',message_id:crypto.randomUUID(),message:{parts:[{type:'text',text:`Check the native client, pass ${i+1}.`}]}},
     {kind:'tool_call_started',call:{id:tool,name:'Read',input:{file_path:'dock-example.ts'}},origin:{kind:'root'}},
     {kind:'tool_call_completed',tool_call_id:tool,output:{text:'export const example = 1;'},is_error:false},
     {kind:'assistant_message_completed',message_id:message,origin:{kind:'root'},text:'## Verification result\n\nThe native transcript retains **formatted text** and code.\n\n```typescript\nexport const example = 1;\n```\n\n- Stable rows\n- Bounded history\n',thinking:null},
     {kind:'turn_completed',stop_reason:'completed',usage:{input_tokens:100,output_tokens:100,cache_read_tokens:0,cache_write_tokens:0},cost_usd:null,duration_ms:1000,terminal_message_id:message},
    ]
    for(const event of events)insert.run(thread.id,turn,'2026-10-15T09:00:00Z',event.kind,JSON.stringify(event))
   }
   db.query('UPDATE threads SET last_seq=(SELECT MAX(seq) FROM events WHERE thread_id=?) WHERE id=?').run(thread.id,thread.id)
  })()
 }finally{db.close()}
 child=Bun.spawn(args,{env:{...process.env,KYBERN_DATA_DIR:data,KYBERN_CLIENT_CONFIG_DIR:path.join(scratch,'client'),KYBERN_GPUIX_CREDENTIALS_DIR:path.join(scratch,'credentials'),KYBERN_GPUIX_THREAD:thread.id,KYBERN_GPUIX_ENVIRONMENT:'local',KYBERN_URL:'',KYBERN_TOKEN:''},stdout:'inherit',stderr:'inherit',stdin:'inherit'})
 process.exitCode=await child.exited
}finally{
 child?.kill();client?.close();daemon.kill()
 await new Promise<void>(resolve=>{if(daemon.exitCode!==null)resolve();else daemon.once('exit',()=>resolve())})
 rmSync(scratch,{recursive:true,force:true})
}
