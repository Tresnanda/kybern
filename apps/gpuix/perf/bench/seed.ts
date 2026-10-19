/** Scratch-only deterministic workload. RPC creates records; SQL appends synthetic
 * provider events (no public import RPC exists). No actual agent is started. */
import {onExit} from './lifetime.ts'
import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { spawn, execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync, readdirSync, copyFileSync } from 'node:fs'
import path from 'node:path'
import { assertScratchEnv } from '../../src/requests/harness.ts'
import { connect, gradientPng } from '../../visual/fixture.ts'
export const DEFAULT_DATA = '/Users/mymac/projects/ade-gpuix-scratch/perf-bench'
export const VERSION = 1
export type Manifest = { version: number; projects: string[]; threads: string[]; long1000: string; long3000: string; running: string; projectPath: string; markdown: string; code: string; counts: Record<string, number>; synthetic: string[] }
const id = (key: string) => { const h=createHash('sha256').update(`bench-v1:${key}`).digest('hex'); return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}` }
export function markdown(i: number) {
 const code=Array.from({length:i%10===0?160:12},(_,j)=>`export const row${j} = { key: ${j}, label: "Stable Unicode 🌿", selected: false };`).join('\n')
 return `## Result ${i+1}\n\nPreserve **formatted output**, *selection*, and reading position. The investigation checks bounded rendering while new content arrives.\n\n| Stage | Status | Duration |\n| --- | --- | ---: |\n| Parse | complete | 12 ms |\n| Paint | complete | 8 ms |\n\n> Keep the user's current reading position.\n\n- Stable message identities\n- Reachable earlier history\n\n\`\`\`typescript\n${code}\n\`\`\`\n\n\`\`\`diff\n@@ -1 +1 @@\n-const view = old();\n+const view = stable();\n\`\`\`\n\nBENCH_RESULT_${i+1}\n`
}
export async function seed(data = DEFAULT_DATA, port = 4322) {
 data=path.resolve(data)
 const env={KYBERN_DATA_DIR:data,KYBERN_URL:'',KYBERN_TOKEN:'',KYBERN_CLIENT_CONFIG_DIR:path.join(data,'client')};assertScratchEnv(env)
 if(data===path.parse(data).root||data===path.resolve(process.env.HOME!)||!data.includes('scratch'))throw Error('Benchmark data must be in a named scratch directory')
 mkdirSync(data,{recursive:true})
 const ownership=path.join(data,'bench-owner.json')
 const prior=readdirSync(data).filter(name=>name!=='bench-run.lock')
 if(!existsSync(ownership)&&prior.length&&!existsSync(path.join(data,'bench-manifest.json')))throw Error('Refusing to seed/delete an existing directory not owned by this benchmark')
 writeFileSync(ownership,JSON.stringify({kind:'gpuix-bench-v1',data}))
 if(spawnSync('lsof',['-nP',`-iTCP:${port}`,'-sTCP:LISTEN','-t'],{encoding:'utf8'}).stdout.trim())throw Error('Scratch port is already in use')
 let daemon=spawn(process.env.KYBERN_TEST_DAEMON??'/Applications/kybern.app/Contents/MacOS/kybernd',['--data-dir',data,'--port',String(port)],{stdio:'ignore'})
 const deadline=Date.now()+30000
 let client:Awaited<ReturnType<typeof connect>>|undefined
 try {
  while(!existsSync(path.join(data,'daemon.port'))){if(daemon.exitCode!==null||Date.now()>deadline)throw Error('Scratch daemon failed to start');await Bun.sleep(30)}
  if(Number(readFileSync(path.join(data,'daemon.port'),'utf8'))!==port)throw Error('Scratch daemon port mismatch')
  client=await connect({daemonPid:daemon.pid!,port,token:readFileSync(path.join(data,'daemon.token'),'utf8').trim(),seeded:false})
  const wheelTemp=path.join(data,`bench-wheel-${process.pid}.dylib`)
  const prebuiltWheel=process.env.KYBERN_BENCH_WHEEL_PREBUILT
  if(prebuiltWheel)copyFileSync(prebuiltWheel,wheelTemp)
  else execFileSync('clang',['-dynamiclib','-fobjc-arc','-framework','Cocoa','-framework','CoreGraphics',path.join(import.meta.dir,'wheel.m'),'-o',wheelTemp])
  renameSync(wheelTemp,path.join(data,'bench-wheel.dylib'))
  let manifest:Manifest
  const manifestFile=path.join(data,'bench-manifest.json')
  if(existsSync(manifestFile)){
   manifest=JSON.parse(readFileSync(manifestFile,'utf8'));if(manifest.version!==VERSION)throw Error('Seed version changed; remove this scratch dataset explicitly')
  }else{
   const projects:string[]=[],threads:string[]=[]
   for(let p=0;p<20;p++){
    const folder=path.join(data,'projects',`project-${String(p).padStart(2,'0')}`);mkdirSync(folder,{recursive:true})
    if(p===0){
     mkdirSync(path.join(folder,'src'),{recursive:true});mkdirSync(path.join(folder,'docs'),{recursive:true})
     for(let f=0;f<2400;f++)writeFileSync(path.join(folder,`module-${String(f).padStart(4,'0')}.ts`),`export const value = ${f};\n`)
     mkdirSync(path.join(folder,'expanded'),{recursive:true})
     for(let f=0;f<10000;f++)writeFileSync(path.join(folder,'expanded',`row-${String(f).padStart(5,'0')}.ts`),`export const row = ${f};\n`)
     writeFileSync(path.join(folder,'huge.md'),Array.from({length:720},(_,i)=>markdown(i)).join('\n'))
     writeFileSync(path.join(folder,'huge.ts'),Array.from({length:28000},(_,i)=>`export const item${i} = { id: ${i}, title: "Large preview row ${i}", active: true };`).join('\n'))
     writeFileSync(path.join(folder,'long.md'),Array.from({length:32},(_,i)=>markdown(i)).join('\n'))
     writeFileSync(path.join(folder,'long.ts'),Array.from({length:3000},(_,i)=>`export const item${i} = { id: ${i}, title: "Preview row ${i}", active: true };`).join('\n'))
     writeFileSync(path.join(folder,'fixture.png'),gradientPng(640,360))
     execFileSync('git',['init','-q',folder]);execFileSync('git',['-C',folder,'add','.']);execFileSync('git',['-C',folder,'commit','-qm','Synthetic fixture'],{env:{...process.env,GIT_AUTHOR_NAME:'Bench fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'Bench fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid',GIT_AUTHOR_DATE:'2026-10-01T00:00:00Z',GIT_COMMITTER_DATE:'2026-10-01T00:00:00Z'}})
    }
    const project=await client.call('projects.add',{path:folder,name:`Bench project ${String(p).padStart(2,'0')}`});projects.push(project.id)
    for(let t=0;t<15;t++){
     const n=p*15+t,title=n===0?'Bench long 1000':n===1?'Bench long 3000':n===2?'Bench running':`Bench ${String(n).padStart(3,'0')} · Investigate stable rendering`
     const thread=await client.call('threads.create',{project_id:project.id,title,provider:{kind:'claude-code',instance:'default'},model:'claude-haiku-5-5'});threads.push(thread.id)
    }
    await client.call('notes.create',{scope:'project',project_id:project.id,title:`Bench note ${p}`,body:markdown(p)})
    await client.call('tasks.items.create',{scope:'project',project_id:project.id,title:`Bench task ${p}`,body:'Preserve formatting and verify long content.',status:p%2?'todo':'inbox',priority:3})
   }
   const db=new Database(path.join(data,'state.sqlite'))
   try{db.transaction(()=>{
    const insert=db.query('INSERT INTO events(thread_id,turn_id,at,kind,payload) VALUES (?,?,?,?,?)')
    for(const [index,thread] of threads.entries()){
     const count=index===0?1000:index===1?3000:index===2?1:3
     for(let t=0;t<count;t++){
      const key=`${index}:${t}`,turn=id(`turn:${key}`),message=id(`answer:${key}`),tool=id(`tool:${key}`),at=new Date(Date.UTC(2026,9,1,0,t)).toISOString()
      const events:Record<string,unknown>[]=[
       {kind:'turn_started',message_id:id(`user:${key}`),message:{parts:[{type:'text',text:`Bench prompt ${t+1}: inspect rendering and preserve reading position.`},...(t%100===0?[{type:'image',media_type:'image/png',data:gradientPng(64,36).toString('base64')}]:[])]}},
       {kind:'tool_call_started',call:{id:tool,name:t%2?'Read':'Edit',input:{file_path:'src/view.ts',old_string:'old()',new_string:'stable()'}},origin:{kind:'root'}},
       {kind:'tool_call_completed',tool_call_id:tool,output:{text:'@@ -1 +1 @@\n-const view = old();\n+const view = stable();'},is_error:false},
       {kind:'assistant_message_completed',message_id:message,origin:{kind:'root'},text:markdown(t),thinking:null},
       {kind:'turn_completed',stop_reason:'completed',usage:{input_tokens:1000,output_tokens:500,cache_read_tokens:0,cache_write_tokens:0},cost_usd:null,duration_ms:1000,terminal_message_id:message},
      ]
      if(index===2)events.splice(2)
      for(const event of events)insert.run(thread,turn,at,String(event.kind),JSON.stringify(event))
     }
     db.query('UPDATE threads SET last_seq=(SELECT MAX(seq) FROM events WHERE thread_id=?),updated_at=? WHERE id=?').run(thread,'2026-10-17T00:00:00Z',thread)
    }
    db.query("UPDATE threads SET status='running' WHERE id=?").run(threads[2]!)
   })()}finally{db.close()}
   const projectPath=path.join(data,'projects/project-00')
   manifest={version:VERSION,projects,threads,long1000:threads[0]!,long3000:threads[1]!,running:threads[2]!,projectPath,markdown:path.join(projectPath,'long.md'),code:path.join(projectPath,'long.ts'),counts:{projects:20,threads:300,turns:4892,treeFiles:12405,markdownSections:32,codeLines:3000,expandedTreeRows:10000,hugeMarkdownSections:720,hugeCodeLines:28000,notes:20,tasks:20},synthetic:['Provider events appended with the same SQLite technique as pacing-fixture.ts; no model execution.','One running thread is persisted synthetic state.','PR pages reuse actionFixture({long:true}); no GitHub calls.','Streaming injects production applyEvent deltas in the process, with no live provider.','fixture.png is locally generated by existing gradientPng.']}
   writeFileSync(manifestFile,JSON.stringify(manifest,null,2))
  }
  // A real idle fixture must not restore a persisted running marker on refresh.
  const runningStatus=process.env.KYBERN_BENCH_PERSISTED_IDLE==='1'?'idle':'running'
  const runningDb=new Database(path.join(data,'state.sqlite'));try{runningDb.query("UPDATE threads SET status=? WHERE id=?").run(runningStatus,manifest.running)}finally{runningDb.close()}
  if(runningStatus==='idle')manifest={...manifest,synthetic:[...manifest.synthetic,'Persisted fixture status is idle for the dedicated parked-window check.']}
  env.KYBERN_URL=`ws://127.0.0.1:${port}/ws`;env.KYBERN_TOKEN=readFileSync(path.join(data,'daemon.token'),'utf8').trim()
  let closed=false,unregister=()=>{}
  const close=async()=>{if(closed)return;closed=true;client?.close();daemon.kill();if(daemon.exitCode===null&&daemon.signalCode===null)await new Promise<void>(resolve=>daemon.once('exit',()=>resolve()));unregister()}
  unregister=onExit(close)
  const restart=async()=>{
   if(closed)throw Error('Cannot restart a closed scratch fixture')
   // This marker is fixture-only, with no provider session. Hide it during
   // restart so orphan recovery does not rewrite the synthetic stream history.
   const beforeRestart=new Database(path.join(data,'state.sqlite'))
   const runningHead=beforeRestart.query('SELECT last_seq FROM threads WHERE id=?').get(manifest.running) as {last_seq:number}
   try{beforeRestart.query("UPDATE threads SET status='idle' WHERE id=?").run(manifest.running)}finally{beforeRestart.close()}
   client?.close();daemon.kill()
   if(daemon.exitCode===null&&daemon.signalCode===null)await new Promise<void>(resolve=>daemon.once('exit',()=>resolve()))
   rmSync(path.join(data,'daemon.port'),{force:true})
   daemon=spawn(process.env.KYBERN_TEST_DAEMON??'/Applications/kybern.app/Contents/MacOS/kybernd',['--data-dir',data,'--port',String(port)],{stdio:'ignore'})
   const until=Date.now()+30000
   while(!existsSync(path.join(data,'daemon.port'))){if(daemon.exitCode!==null||Date.now()>until)throw Error('Scratch daemon restart failed');await Bun.sleep(30)}
   env.KYBERN_TOKEN=readFileSync(path.join(data,'daemon.token'),'utf8').trim()
   client=await connect({daemonPid:daemon.pid!,port,token:env.KYBERN_TOKEN,seeded:true})
   const afterRestart=new Database(path.join(data,'state.sqlite'))
   try{
    const head=afterRestart.query('SELECT last_seq FROM threads WHERE id=?').get(manifest.running) as {last_seq:number}
    if(head.last_seq!==runningHead.last_seq)throw Error('Restart changed the synthetic running thread history')
    afterRestart.query("UPDATE threads SET status=? WHERE id=?").run(runningStatus,manifest.running)
   }finally{afterRestart.close()}
  }
  return {data,manifest,env,get client(){return client!},restart,close,remove:()=>{const owner=JSON.parse(readFileSync(ownership,'utf8'));if(owner.kind!=='gpuix-bench-v1'||owner.data!==data)throw Error('Scratch ownership changed; refusing cleanup');rmSync(data,{recursive:true,force:true})}}
 }catch(error){client?.close();daemon.kill();throw error}
}
if(import.meta.main){const fixture=await seed(process.env.KYBERN_DATA_DIR??DEFAULT_DATA,Number(process.env.KYBERN_BENCH_PORT??4322));console.log(JSON.stringify(fixture.manifest,null,2));await fixture.close()}
