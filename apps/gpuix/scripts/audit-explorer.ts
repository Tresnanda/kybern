import {connect,getClient,getState} from '../src/state.ts'
import {mkdirSync,existsSync,rmSync,writeFileSync} from 'node:fs'
import path from 'node:path'
import {execFileSync} from 'node:child_process'
const folder=path.resolve('../../.p5/project');if(existsSync(folder))throw Error('Refuse to replace existing explorer fixture')
mkdirSync(folder,{recursive:true});execFileSync('git',['init','-q',folder]);writeFileSync(path.join(folder,'dock-example.ts'),'export const example = 1;\n');execFileSync('git',['-C',folder,'add','.']);execFileSync('git',['-C',folder,'-c','user.name=Audit','-c','user.email=audit@example.test','commit','-qm','fixture']);connect();while(getState().status!=='open')await Bun.sleep(30)
const client=getClient()!
try{
 const project=await client.call('projects.add',{path:folder,name:'Explorer audit'})
 const thread=await client.call('threads.create',{project_id:project.id,title:'Explorer audit',provider:{kind:'claude-code',instance:'default'}})
 const child=Bun.spawn(['bun',process.argv[2]??'src/dock/verify-explorer.ts'],{env:{...process.env,KYBERN_GPUIX_THREAD:thread.id},stdout:'inherit',stderr:'inherit'})
 process.exitCode=await child.exited
}finally{client.close();rmSync(folder,{recursive:true,force:true})}
