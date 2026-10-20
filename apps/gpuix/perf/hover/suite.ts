import {spawn, execFileSync} from 'node:child_process'
import {mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs'
import path from 'node:path'
import {SCRATCH,CLIENT_DIR,CREDS_DIR,DATA_DIR,startDaemon,seed,readState,connect,stopPid,stopVite,freePort} from '../../visual/fixture.ts'
import {loadAreaFixtures} from '../../visual/load.ts'
import type {Fixture} from '../../visual/screens.gpuix.ts'
const out=process.env.HR5_OUT??'/Users/mymac/projects/ade/previews/gpuix/handson-r5/hover'
let active:ReturnType<typeof spawn>|undefined
for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>{active?.kill(signal)})
mkdirSync(out,{recursive:true});mkdirSync(SCRATCH,{recursive:true})
if(!SCRATCH.includes('/hr5-hover')&&!SCRATCH.includes('/sidebar-fix-'))throw Error('Set VISUAL_SCRATCH to this lane')
process.env.KYBERN_DATA_DIR=DATA_DIR;process.env.KYBERN_CLIENT_CONFIG_DIR=CLIENT_DIR;process.env.KYBERN_GPUIX_CREDENTIALS_DIR=CREDS_DIR
execFileSync('clang',['-dynamiclib','-fobjc-arc','-framework','Cocoa','perf/hover/input.m','-o',path.join(SCRATCH,'hover-input.dylib')])
let state=await startDaemon(true),vitePid:number|undefined
try{
 await seed(state);state=readState()!
 const client=await connect(state)
 const projects=(await client.call('projects.list',{})).projects
 const primary=projects.find(project=>project.name==='kybern-app')
 if(!primary)throw Error('Missing kybern-app fixture project')
 for(let i=0;i<32;i++){
  await client.call('notes.create',{scope:'project',project_id:primary.id,title:`Hover audit note ${i}`,body:'Selectable document body. **Formatted prose** stays intact.'})
  await client.call('tasks.items.create',{scope:'project',project_id:primary.id,title:`Hover audit task ${i}`,body:'Audit pointer behavior.',status:i%2?'todo':'inbox',priority:3})
 }
 for(let i=0;i<4;i++){
  const folder=path.join(SCRATCH,`hover-project-${i}`);mkdirSync(folder,{recursive:true})
  const project=await client.call('projects.add',{path:folder,name:`zz Hover project ${i}`})
  for(let t=0;t<8;t++)await client.call('threads.create',{project_id:project.id,title:`Hover thread ${i}-${t}`,provider:{kind:'claude-code',instance:'default'},model:'claude-haiku-5-5'})
 }
 const files=path.join(primary.path!,'src');mkdirSync(files,{recursive:true})
 for(let i=0;i<100;i++)writeFileSync(path.join(files,`hover-row-${String(i).padStart(3,'0')}.ts`),'export const hover = true;\n')
 const fixture:Fixture={notes:{},tasks:{},taskKeys:{},extra:{}}
 try{
  fixture.notes=Object.fromEntries((await client.call('notes.list',{})).notes.map(n=>[n.title,n.id]))
  const tasks=(await client.call('tasks.items.list',{})).tasks
  fixture.tasks=Object.fromEntries(tasks.map(t=>[t.title,t.id]));fixture.taskKeys=Object.fromEntries(tasks.map(t=>[t.key,t.id]))
  for(const [area,f]of Object.entries(await loadAreaFixtures()))if(f.ids)fixture.extra[area]=await f.ids(client)
 }finally{client.close()}
 state=readState()!
 const ids=path.join(SCRATCH,'hover-fixture.json');writeFileSync(ids,JSON.stringify(fixture))
 const env: NodeJS.ProcessEnv={...process.env,KYBERN_DATA_DIR:DATA_DIR,KYBERN_CLIENT_CONFIG_DIR:CLIENT_DIR,KYBERN_GPUIX_CREDENTIALS_DIR:CREDS_DIR,KYBERN_URL:`ws://127.0.0.1:${state.port}/ws`,KYBERN_TOKEN:state.token,HR5_OUT:out,HR5_FIXTURE:ids}
 const requested=process.env.HR5_SCREENS?.split(',')
 const groups=[['shell-home','thread-header','conversation-helpers','shell-new-chat-hover','composer-home-workspace'],['notes-list','notes-gallery','tasks-list','tasks-board','notes-editor'],['dock-explorer','dock-explorer-file','dock-agents','dock-notes','dock-tasks'],['settings-general','dock-add-menu','palette','pulls-list']].map(group=>requested?group.filter(name=>requested.includes(name)):group).filter(group=>group.length)
 const chosenThemes=(process.env.HR5_THEMES??'dark,light').split(','),chosenMotion=(process.env.HR5_MOTION??'0,1').split(',')
 if(process.env.HR5_BASELINE_ADDON){
  const beforeOut=path.join(out,'before-app');mkdirSync(beforeOut,{recursive:true})
  for(const theme of chosenThemes)for(const reduce of chosenMotion){
   const child=active=spawn('bun',['native/ui-lease.ts','hr5-hover-before','bun','perf/hover/audit.ts',theme,reduce,'shell-home','thread-header','conversation-helpers'],{env:{...env,HR5_OUT:beforeOut,HR5_SOURCE:'before',NAPI_RS_NATIVE_LIBRARY_PATH:process.env.HR5_BASELINE_ADDON},stdio:'inherit'})
   const code=await new Promise<number>(resolve=>child.once('exit',code=>resolve(code??1)));active=undefined
   if(code)throw Error(`Before audit fixture failed: ${theme}/${reduce}`)
  }
 }
 const afterOut=path.join(out,'after-app');mkdirSync(afterOut,{recursive:true})
 if(process.env.HR5_SKIP_NATIVE!=='1')for(const theme of chosenThemes)for(const reduce of chosenMotion)for(const names of groups){
  const child=active=spawn('bun',['native/ui-lease.ts','hr5-hover-audit','bun','perf/hover/audit.ts',theme,reduce,...names],{env:{...env,HR5_OUT:afterOut,HR5_SOURCE:'after'},stdio:'inherit'})
  const code=await new Promise<number>(resolve=>child.once('exit',code=>resolve(code??1)))
  active=undefined
  if(code)throw Error(`Audit failed: ${theme}/${reduce}/${names}`)
 }
 // Desktop reference is the actual frontend in headless WebKit; never Tauri.
 if(process.env.HR5_SKIP_DESKTOP==='1')process.exitCode=0
 else {
 const {NAPI_RS_NATIVE_LIBRARY_PATH:_native,...viteEnv}=env
 const port=await freePort(),vite=spawn('pnpm',['exec','vite','--host','127.0.0.1','--port',String(port),'--strictPort'],{cwd:path.resolve('../desktop'),env:viteEnv,stdio:'ignore',detached:true});vitePid=vite.pid
 for(let i=0;i<100;i++){try{if((await fetch(`http://127.0.0.1:${port}`)).ok)break}catch{}await Bun.sleep(100)}
 for(const theme of chosenThemes)for(const reduced of chosenMotion)for(const names of groups){
  const desktopOut=path.join(out,reduced==='0'?'desktop-normal':'desktop-reduced');mkdirSync(desktopOut,{recursive:true})
  const code=await new Promise<number>((resolve,reject)=>{active=spawn('bun',['native/ui-lease.ts','hr5-hover-webkit','node','perf/hover/webkit.mjs',JSON.stringify({port:state.port,token:state.token,vite:port,theme,screens:names,out:desktopOut,evidence:out})],{env:{...viteEnv,KYBERN_REDUCED_MOTION:reduced,PLAYWRIGHT_CORE:'/Users/mymac/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs'},stdio:'inherit'});active.once('error',reject);active.once('exit',code=>resolve(code??1))});active=undefined
  if(code)throw Error('WebKit reference failed')
 }

 }
}finally{active?.kill();stopPid(vitePid);state=readState()??state;stopPid(state.proxyPid);stopPid(state.daemonPid);stopVite(state)}
