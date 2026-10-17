import {Database} from 'bun:sqlite'
import {randomUUID} from 'node:crypto'
import {DATA_DIR} from './fixture.ts'
import path from 'node:path'
import type {KybernClient} from '../../../packages/kybern-client/src/client.ts'
export async function seed(client:KybernClient,ctx:{projects:{id:string}[]}){
 const existing=(await client.call('threads.list',{})).threads
 if(existing.some(t=>t.title==='Rounded clip review'))return
 const thread=await client.call('threads.create',{project_id:ctx.projects[0]!.id,title:'Rounded clip review',provider:{kind:'claude-code',instance:'default'},model:'claude-haiku-5-5'})
 await client.call('threads.update',{thread_id:thread.id,pinned:true})
 const turn=randomUUID(),answer=randomUUID(),usage={input_tokens:10,output_tokens:10,cache_read_tokens:0,cache_write_tokens:0}
 const events=[{kind:'turn_started',message_id:randomUUID(),message:{parts:[{type:'text',text:'Show the development commands.'}]}},
  {kind:'assistant_message_completed',message_id:answer,origin:{kind:'root'},text:'```sh\ncd ~/projects/ade-gpuix/apps/gpuix\npnpm dev\n```\n\n```sh\nprintf "%s\\n" '+('long-path/'.repeat(20))+'\n```',thinking:null},
  {kind:'turn_completed',stop_reason:'completed',usage,cost_usd:null,duration_ms:1000,terminal_message_id:answer}]
 const db=new Database(path.join(DATA_DIR,'state.sqlite'))
 try{db.transaction(()=>{const insert=db.query('INSERT INTO events(thread_id,turn_id,at,kind,payload) VALUES (?,?,?,?,?)');for(const event of events)insert.run(thread.id,turn,'2026-10-16T12:00:00Z',event.kind,JSON.stringify(event));db.query('UPDATE threads SET last_seq=(SELECT MAX(seq) FROM events WHERE thread_id=?) WHERE id=?').run(thread.id,thread.id)})()}finally{db.close()}
}
export async function ids(client:KybernClient){const threads=(await client.call('threads.list',{})).threads;return {thread:threads.find(t=>t.title==='Rounded clip review')!.id}}
