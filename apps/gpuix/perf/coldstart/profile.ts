/** Diagnostic only: no UI and excluded from final startup/resource repeats. */
import {Database} from 'bun:sqlite'
import {readFileSync,writeFileSync} from 'node:fs'
import path from 'node:path'
import {KybernClient} from '../../../../packages/kybern-client/src/client.ts'
import {assertScratchEnv} from '../../src/requests/harness.ts'
const out=process.argv[2]!,data=process.env.KYBERN_DATA_DIR!
assertScratchEnv({KYBERN_DATA_DIR:data,KYBERN_URL:''})
const client=new KybernClient({url:'ws://127.0.0.1:4336/ws',token:readFileSync(path.join(data,'daemon.token'),'utf8').trim()})
client.connect()
try{
 while(client.status!=='open')await Bun.sleep(10)
 const sample=Bun.spawn(['sample',process.env.KYBERN_STARTUP_DAEMON_PID!,'5','1','-file',out.replace(/\.json$/,'.sample.txt')],{stdout:'ignore',stderr:'ignore'})
 const requests:{method:string;ms:number;bytes:number}[]=[]
 async function call(method:'threads.get'|'threads.list'|'projects.list'|'threads.target.get',params:Record<string,unknown>){const at=performance.now();const result=await client.call(method,params);requests.push({method,ms:performance.now()-at,bytes:JSON.stringify(result).length})}
 for(const thread of [process.env.KYBERN_STARTUP_THREAD!,process.env.KYBERN_STARTUP_OTHER_THREAD!,process.env.KYBERN_STARTUP_COLD_OTHER_THREAD!]){
  const content=call('threads.get',{thread_id:thread,transcript_limit:120,include_tool_output:false})
  await Bun.sleep(10)
  await Promise.all([content,call('threads.list',{}),call('projects.list',{})])
 }
 for(let i=0;i<3;i++)await call('threads.target.get',{thread_id:process.env.KYBERN_STARTUP_THREAD!})
 if(await sample.exited)throw Error('Scratch daemon sample failed')
 const snapshots=[]
 for(const thread of [process.env.KYBERN_STARTUP_THREAD!,process.env.KYBERN_STARTUP_OTHER_THREAD!]){
  const head=await client.call('threads.get',{thread_id:thread,transcript_limit:120,include_tool_output:false})
  snapshots.push(head)
  for(const through of [Math.max(0,head.thread.last_seq-500),head.thread.last_seq]){
   const page=await client.call('threads.get',{thread_id:thread,transcript_limit:120,include_tool_output:false,through_seq:through})
   snapshots.push(page)
   if(page.next_before_seq!=null)snapshots.push(await client.call('threads.get',{thread_id:thread,transcript_limit:120,include_tool_output:false,through_seq:through,before_seq:page.next_before_seq}))
  }
 }
 writeFileSync(out.replace(/\.json$/,'.snapshots.json'),JSON.stringify(snapshots))
 const db=new Database(path.join(data,'state.sqlite'),{readonly:true})
 const queries=[]
 for(const [name,where] of [['tasks',"kind IN ('runtime_task_started','runtime_task_updated','runtime_task_completed','provider_session_bound')"],['usage',"kind = 'provider_usage_updated'"],['commands',"kind = 'provider_commands_updated'"],['questions',"kind IN ('async_questions_requested','async_questions_answered')"]]){
  const query=`SELECT payload FROM events WHERE thread_id = ?1 AND seq <= ?2 AND ${where} ORDER BY seq`
  const plan=db.query('EXPLAIN QUERY PLAN '+query).all(process.env.KYBERN_STARTUP_THREAD!,Number.MAX_SAFE_INTEGER)
  const times=[]
  for(let i=0;i<5;i++){const at=performance.now();db.query(query).all(process.env.KYBERN_STARTUP_THREAD!,Number.MAX_SAFE_INTEGER);times.push(performance.now()-at)}
  queries.push({name,plan,times})
 }
 db.close()
 writeFileSync(out,JSON.stringify({diagnostic:true,fixture:JSON.parse(process.env.KYBERN_COLDSTART_FIXTURE??'null'),fullRate:'not applicable: daemon-only diagnostic; app acceptance runs use 1',requests,queries},null,2))
}finally{client.close()}
