// Supply fresh isolated fixtures to the existing environment/API/dialog checks.
import {spawn,execFileSync} from 'node:child_process'
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync,copyFileSync} from 'node:fs'
import path from 'node:path'
import {KybernClient} from '../../../packages/kybern-client/src/client.ts'
const base='/Users/mymac/projects/ade-gpuix-scratch';mkdirSync(base,{recursive:true})
const scratch=mkdtempSync(path.join(base,'audit-env-')),data=path.join(scratch,'data'),project=path.join(scratch,'project')
mkdirSync(data);mkdirSync(project);execFileSync('git',['init','-q',project]);writeFileSync(path.join(project,'README.md'),'# Audit environment fixture\n');execFileSync('git',['-C',project,'add','.']);execFileSync('git',['-C',project,'-c','user.name=Audit','-c','user.email=audit@example.test','commit','-qm','fixture'])
const daemon=spawn('/Applications/kybern.app/Contents/MacOS/kybernd',['--data-dir',data,'--port','0'],{stdio:'ignore'})
const results:any[]=[],out='/Users/mymac/projects/ade/previews/gpuix/audit-2026-10-16/checks/'+(process.argv.includes('--isolation-only')?'environments-isolation':'environments');mkdirSync(out,{recursive:true})
let client:KybernClient|undefined
try{
 for(let i=0;i<300&&!existsSync(path.join(data,'daemon.port'));i++)await Bun.sleep(50)
 const port=readFileSync(path.join(data,'daemon.port'),'utf8').trim();if(port==='4219')throw Error('Reserved port')
 const token=readFileSync(path.join(data,'daemon.token'),'utf8').trim(),url=`ws://127.0.0.1:${port}/ws`
 client=new KybernClient({url,token});client.connect();while(client.status!=='open')await Bun.sleep(30)
 const p=await client.call('projects.add',{path:project,name:'Second environment'})
 Object.assign(process.env,{KYBERN_CLIENT_CONFIG_DIR:path.join(scratch,'client'),KYBERN_GPUIX_CREDENTIALS_DIR:path.join(scratch,'credentials'),KYBERN_VERIFY_SECOND_DATA:data,KYBERN_VERIFY_SECOND_PROJECT:p.id,KYBERN_VERIFY_PROJECT:project,KYBERN_VERIFY_OUTPUT:out,FORMS_ONLY:'1'})
 const run=async(file:string,args:string[]=[])=>{
  const log=path.join(out,file.replaceAll('/','__')+args.join('-')+'.log');const f=Bun.file(log).writer();const start=performance.now()
  const childOut=file==='src/environments/verify-api.ts'?out:path.join(out,file.replaceAll('/','__')+'-'+args.join('-'));mkdirSync(childOut,{recursive:true})
  if(childOut!==out&&existsSync(path.join(out,'worktree-fixture.json')))copyFileSync(path.join(out,'worktree-fixture.json'),path.join(childOut,'worktree-fixture.json'))
  const child=Bun.spawn(['bun',file,...args],{env:{...process.env,KYBERN_VERIFY_OUTPUT:childOut},stdout:'pipe',stderr:'pipe'})
  const [stdout,stderr]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text()]);const code=await child.exited;f.write(stdout+stderr);await f.end()
  results.push({file:file==='scripts/audit-env-isolation.ts'?'scripts/env-isolation-check.ts':file,mode:args.join(' ')||'isolated API',status:code?'Fail':'Pass',exit:code,log,seconds:(performance.now()-start)/1000,tail:(stdout+stderr).slice(-2200)});writeFileSync(path.join(out,'results.json'),JSON.stringify(results,null,2));console.log(file,args,code)
 }
 if(!process.argv.includes('--isolation-only'))await run('src/environments/verify-api.ts')
 const {saveEnvironment}=await import('../src/environments/actions.ts')
 await saveEnvironment({id:'scratch-second',name:'Second environment',address:url,token})
 if(!process.argv.includes('--isolation-only'))for(const motion of ['normal','reduced'])for(const theme of ['dark','light']){
  process.env.KYBERN_REDUCED_MOTION=motion==='reduced'?'1':'0'
  await run('src/environments/verify.ts',[theme,motion])
  await run('src/dialogs/verify.ts',[theme,motion])
 }
 const firstData=process.env.KYBERN_DATA_DIR!
 const first=new KybernClient({url:`ws://127.0.0.1:${readFileSync(path.join(firstData,'daemon.port'),'utf8').trim()}/ws`,token:readFileSync(path.join(firstData,'daemon.token'),'utf8').trim()})
 first.connect();while(first.status!=='open')await Bun.sleep(30)
 try {
  await first.call('notes.create',{scope:'global',title:'Isolation probe note A',body:'Audit fixture'})
  await first.call('tasks.items.create',{scope:'global',title:'Isolation probe task A',body:'Audit fixture'})
 }finally{first.close()}
 writeFileSync(path.join(scratch,'client','notes-preferences.json'),JSON.stringify({globalHome:'separate'}))
 for(const mode of ['normal','reduced']) { process.env.KYBERN_REDUCED_MOTION=mode==='reduced'?'1':'0';await run('scripts/audit-env-isolation.ts',[mode]) }

 if(results.some(r=>r.exit!==0))process.exitCode=1
}finally{client?.close();daemon.kill();await new Promise<void>(resolve=>{if(daemon.exitCode!==null)resolve();else daemon.once('exit',()=>resolve())});rmSync(scratch,{recursive:true,force:true})}
