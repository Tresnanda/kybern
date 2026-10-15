/** Prepare a composer in our isolated daemon, then run the original navigation smoke. */
import {mkdirSync,readFileSync} from 'node:fs'
import path from 'node:path'
import {KybernClient} from '../../../../packages/kybern-client/src/client.ts'
const dir=process.env.KYBERN_DATA_DIR
if(!dir?.includes('gpuix-scratch'))throw Error('Use scratch data')
const client=new KybernClient({url:`ws://127.0.0.1:${readFileSync(path.join(dir,'daemon.port'),'utf8').trim()}/ws`,token:readFileSync(path.join(dir,'daemon.token'),'utf8').trim()})
client.connect();for(let i=0;client.status!=='open'&&i<100;i++)await Bun.sleep(50)
const folder=path.join(dir,'project');mkdirSync(folder,{recursive:true})
try {
 const project=await client.call('projects.add',{path:folder,name:'Scratch verification'})
 const thread=await client.call('threads.create',{project_id:project.id,title:'Settings verification',provider:{kind:'codex',instance:'default'}})
 const child=Bun.spawn(['bun',path.join(import.meta.dir,'../../scripts/settings-check.ts'),'/Users/mymac/projects/ade/previews/gpuix/p6/navigation',...process.argv.slice(2)],{env:{...process.env,KYBERN_GPUIX_THREAD:thread.id},stdout:'inherit',stderr:'inherit'})
 if(await child.exited)process.exitCode=1
}finally {client.close()}
