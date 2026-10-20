// Continue exact GPUIX pair steps with per-screen failure accounting.
import path from 'node:path'
import {mkdirSync,rmSync,existsSync,writeFileSync,readFileSync} from 'node:fs'
import {readState,connect,DATA_DIR,CLIENT_DIR,CREDS_DIR} from '../visual/fixture.ts'
import {loadAreaFixtures,loadGpuixEntries,loadGpuixScreens} from '../visual/load.ts'
import {launchFixture} from '../src/requests/harness.ts'
const out='/Users/mymac/projects/ade/previews/gpuix/audit-2026-10-16/visual'
const state=readState();if(!state||state.port===4219)throw Error('Isolated seeded visual daemon required')
process.env.KYBERN_URL=`ws://127.0.0.1:${state.port}/ws`;process.env.KYBERN_TOKEN=state.token
const client=await connect(state)
const notes=(await client.call('notes.list',{})).notes,tasks=(await client.call('tasks.items.list',{})).tasks
const extra:Record<string,Record<string,unknown>>={}
for(const [area,f]of Object.entries(await loadAreaFixtures()))if(f.ids)extra[area]=await f.ids(client)
client.close()
const fx={extra,notes:Object.fromEntries(notes.map(x=>[x.title,x.id])),tasks:Object.fromEntries(tasks.map(x=>[x.title,x.id])),taskKeys:Object.fromEntries(tasks.map(x=>[x.key,x.id]))}
const screens=await loadGpuixScreens(),entries=await loadGpuixEntries(),results:any[]=[]
const failed=JSON.parse(readFileSync(path.join(out,'gpuix-results.json'),'utf8')).filter((r:any)=>r.status==='Fail');
for(const {name,theme} of failed){const step=screens[name];
 rmSync(path.join(DATA_DIR,'gpuix-ui.json'),{force:true});rmSync(CLIENT_DIR,{recursive:true,force:true})
 let f:Awaited<ReturnType<typeof launchFixture>>|undefined
 try{
  f=await launchFixture(path.resolve(entries[name]?.entry??'src/main.tsx'),{...(entries[name]?.env??{}),GPUIX_BACKGROUND:'1',KYBERN_OPAQUE:'1',KYBERN_ENVIRONMENT_NAME:'Development environment',KYBERN_APPEARANCE:theme,KYBERN_DATA_DIR:DATA_DIR,KYBERN_CLIENT_CONFIG_DIR:CLIENT_DIR,KYBERN_GPUIX_CREDENTIALS_DIR:CREDS_DIR,KYBERN_REDUCED_MOTION:'1'})
  await f.app.getByTestId('app-ready').waitFor({timeoutMs:60000});await Bun.sleep(1800)
  let error='';try{await step(f.app,fx)}catch(e){error=String(e).replaceAll(state.token,'[redacted]')}
  const paintedText=(await f.app.call('getPaintedText',{})).text.join(' ')
  await f.app.screenshot({path:path.join(out,`${name}-${theme}-failed-state-gpuix.png`)})
  results.push({name,theme,status:'Diagnostic only',error,paintedText});console.log(name,theme,error)
 }catch(e){results.push({name,theme,status:'Fail',error:String(e).replaceAll(state.token,'[redacted]')})}
 finally{await f?.close();writeFileSync(path.join(out,'failed-state-results.json'),JSON.stringify(results,null,2))}
}

// Fixture ids() owns a proxy child; explicit exit runs its registered cleanup.
process.exit(0)
