// Restore the visual fixture boundary after original tool exits on a failed screen.
import {readFileSync,existsSync,rmSync,writeFileSync} from 'node:fs'
import {spawn} from 'node:child_process'
import path from 'node:path'
import {readState,writeState,connect,DATA_DIR,SCRATCH} from '../visual/fixture.ts'
const state=readState();if(!state)throw Error('No audit daemon')
state.port=Number(readFileSync(path.join(DATA_DIR,'daemon.port'),'utf8').trim())
if(state.port===4219)throw Error('Reserved daemon')
const client=await connect(state)
const threads=(await client.call('threads.list',{})).threads
const thread=threads.find(t=>t.title==='Visual worktree');if(!thread)throw Error('Missing seeded worktree')
client.close()
const ready=path.join(SCRATCH,'settings-proxy.json');rmSync(ready,{force:true})
const child=spawn('bun',[path.resolve('visual/fixture.settings.ts'),'--proxy',JSON.stringify({port:state.port,token:state.token,ready,projectId:thread.project_id,threadId:thread.id})],{stdio:'ignore'})
for(let i=0;i<100&&!existsSync(ready);i++)await Bun.sleep(50)
if(!existsSync(ready))throw Error('Proxy failed')
state.port=JSON.parse(readFileSync(ready,'utf8')).port;writeState(state)
writeFileSync('/Users/mymac/projects/ade/previews/gpuix/audit-2026-10-16/proxy-owner.json',JSON.stringify({pid:process.pid,child:child.pid}))
console.log('Audit fixture proxy ready')
process.once('SIGTERM',()=>{child.kill();process.exit(0)})
await new Promise(()=>{})
