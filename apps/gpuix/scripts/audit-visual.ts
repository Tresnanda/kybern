// Continue exact GPUIX pair steps with per-screen failure accounting.
import path from 'node:path'
import {mkdirSync,rmSync,existsSync,writeFileSync} from 'node:fs'
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
for(const theme of ['dark','light'])for(const [name,step]of Object.entries(screens)){
 rmSync(path.join(DATA_DIR,'gpuix-ui.json'),{force:true});rmSync(CLIENT_DIR,{recursive:true,force:true})
 let f:Awaited<ReturnType<typeof launchFixture>>|undefined
 try{
  f=await launchFixture(path.resolve(entries[name]?.entry??'src/main.tsx'),{...(entries[name]?.env??{}),GPUIX_BACKGROUND:'1',KYBERN_OPAQUE:'1',KYBERN_ENVIRONMENT_NAME:'Development environment',KYBERN_APPEARANCE:theme,KYBERN_DATA_DIR:DATA_DIR,KYBERN_CLIENT_CONFIG_DIR:CLIENT_DIR,KYBERN_GPUIX_CREDENTIALS_DIR:CREDS_DIR,KYBERN_REDUCED_MOTION:'1'})
  await f.app.getByTestId('app-ready').waitFor({timeoutMs:60000});await Bun.sleep(1800)
  await step(f.app,fx);const paintedText=(await f.app.call('getPaintedText',{})).text.join(' ');const base=path.join(out,`${name}-${theme}`)
  const expectedState=name.startsWith('notes-editor')?(name==='notes-editor-image'?'Moodboard':'Design review notes'):null
  const stateValid=expectedState===null?null:!!(await f.app.getByTestId('note-editor').count())&&paintedText.includes(expectedState)
  await f.app.screenshot({path:`${base}-gpuix.png`})
  if(!existsSync(`${base}-tauri.png`)){results.push({name,theme,status:'Reference failed',paintedText,expectedState,stateValid});console.log('REFERENCE FAILED',name,theme)}
  else{
   const r=Bun.spawnSync(['swift',path.resolve('visual/compose.swift'),`${base}-tauri.png`,`${base}-gpuix.png`,`${base}-pair.png`,`${base}-diff.png`],{stdout:'pipe',stderr:'pipe'})
   if(r.exitCode)throw Error(r.stderr.toString())
   const metric=r.stdout.toString().trim();results.push({name,theme,status:'Pass',metric,paintedText,expectedState,stateValid});console.log('PASS',name,theme,metric)
  }
 }catch(e){const error=String(e).replaceAll(state.token,'[redacted]');results.push({name,theme,status:'Fail',error,diagnostics:f?.diagnostics()});console.log('FAIL',name,theme,error)}
 finally{await f?.close();writeFileSync(path.join(out,'gpuix-results.json'),JSON.stringify(results,null,2))}
}

// Fixture ids() owns a proxy child; explicit exit runs its registered cleanup.
process.exit(0)
