// Supplemental matching-state captures; the original coordinate-fallback scores remain reported.
import path from 'node:path'
import {readFileSync,writeFileSync,mkdirSync,rmSync} from 'node:fs'
import {readState,connect,DATA_DIR,CLIENT_DIR,CREDS_DIR} from '../visual/fixture.ts'
import {loadAreaFixtures} from '../visual/load.ts'
import {launchFixture} from '../src/requests/harness.ts'
const art='/Users/mymac/projects/ade/previews/gpuix/audit-2026-10-16',out=path.join(art,'visual-supplemental')
const original=JSON.parse(readFileSync(path.join(art,'visual/gpuix-results.json'),'utf8')) as {name:string;theme:string;stateValid?:boolean|null}[]
const targets=original.filter(r=>r.stateValid===false)
if(!targets.length){console.log('No mismatched note states to supplement');process.exit(0)}
mkdirSync(out,{recursive:true});const state=readState()!;process.env.KYBERN_URL=`ws://127.0.0.1:${state.port}/ws`;process.env.KYBERN_TOKEN=state.token
const client=await connect(state),notes=(await client.call('notes.list',{})).notes
for(const f of Object.values(await loadAreaFixtures()))if(f.ids)await f.ids(client)
client.close();const results:any[]=[]
for(const {name,theme}of targets){
 rmSync(path.join(DATA_DIR,'gpuix-ui.json'),{force:true});rmSync(CLIENT_DIR,{recursive:true,force:true})
 const title=name==='notes-editor-image'?'Moodboard':'Design review notes',note=notes.find(n=>n.title===title)!
 let f:Awaited<ReturnType<typeof launchFixture>>|undefined
 try{
  f=await launchFixture(path.resolve('src/main.tsx'),{GPUIX_BACKGROUND:'1',KYBERN_OPAQUE:'1',KYBERN_ENVIRONMENT_NAME:'Development environment',KYBERN_APPEARANCE:theme,KYBERN_DATA_DIR:DATA_DIR,KYBERN_CLIENT_CONFIG_DIR:CLIENT_DIR,KYBERN_GPUIX_CREDENTIALS_DIR:CREDS_DIR,KYBERN_REDUCED_MOTION:'1'})
  const a=f.app;await a.getByTestId('app-ready').waitFor();await Bun.sleep(1800);await a.getByTestId('rail-notes').click();await Bun.sleep(700);await a.getByTestId('notes-filter-all').click();await a.getByTestId('notes-search').fill(title);await Bun.sleep(900);await a.getByTestId(`note-card-${note.id}`).click();await Bun.sleep(1200)
  if(!await a.getByTestId('note-editor').count())throw Error('Requested editor did not open')
  if(name==='notes-editor-scrolled'){await a.mouse.wheel({x:700,y:400},0,-3000);await Bun.sleep(800)}
  await a.mouse.move({x:1275,y:815});await Bun.sleep(300)
  const painted=(await a.call('getPaintedText',{})).text.join(' ');if(!painted.includes(title))throw Error('Wrong editor title')
  const base=path.join(out,`${name}-${theme}`);await a.screenshot({path:base+'-gpuix.png'})
  const r=Bun.spawnSync(['swift',path.resolve('visual/compose.swift'),path.join(art,'visual',`${name}-${theme}-tauri.png`),base+'-gpuix.png',base+'-pair.png',base+'-diff.png'],{stdout:'pipe',stderr:'pipe'})
  if(r.exitCode)throw Error(r.stderr.toString())
  results.push({name,theme,status:'Pass',metric:r.stdout.toString().trim(),method:'Search title, then click matching card; no coordinate fallback',painted});console.log(name,theme,r.stdout.toString().trim())
 }catch(e){results.push({name,theme,status:'Fail',error:String(e)})}
 finally{await f?.close();writeFileSync(path.join(out,'results.json'),JSON.stringify(results,null,2))}
}

// Fixture ids() owns a proxy child; explicit exit runs its registered cleanup.
process.exit(0)
