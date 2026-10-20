// Reuse the existing real-input drag checks with task-scoped data and captures.
import {spawn} from 'node:child_process'
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs'
import path from 'node:path'
import {SCRATCH,DATA_DIR,CLIENT_DIR,startDaemon,stopPid} from '../../visual/fixture.ts'
import {requireScreen} from '../bench/screen-state.ts'
const mode=process.argv[2]??'tasks',out=process.env.SIDEBAR_OUT!
if(!SCRATCH.includes('/sidebar-fix-'))throw Error('Sidebar fix scratch required')
mkdirSync(out,{recursive:true})
const state=await startDaemon(true)
const env={...process.env,GPUIX_BACKGROUND:'1',KYBERN_DATA_DIR:DATA_DIR,KYBERN_CLIENT_CONFIG_DIR:CLIENT_DIR,KYBERN_URL:'',KYBERN_TOKEN:'',R8_DATA:DATA_DIR,R8_OUT:out,R8_LANE:'sidebar-fix-drags',R7_LABEL:'fixed',R7_SAMPLE:'0',R7_LOCK_HELD:'1',KYBERN_APPEARANCE:'dark',KYBERN_REDUCED_MOTION:'0',DRAG_OUT:out,DRAG_CAPTURE_FRAMES:'0,5,18,34',DRAG_FG:'',NAPI_RS_NATIVE_LIBRARY_PATH:path.resolve('native/build/gpuix-native.darwin-arm64.node')}
let child:ReturnType<typeof spawn>|undefined,restore:()=>void=()=>{}
const run=async(args:string[])=>{
 child=spawn('bun',args,{env,stdio:'inherit'})
 const code=await new Promise<number>((resolve,reject)=>{child!.once('error',reject);child!.once('exit',code=>resolve(code??1))});child=undefined
 if(code)throw Error(`Drag check failed (${code}): ${args.join(' ')}`)
}
for(const signal of ['SIGTERM','SIGINT']as const)process.once(signal,()=>child?.kill(signal))
process.once('exit',()=>restore())
try{
 requireScreen()
 const file=path.resolve(mode==='tasks'?'src/tasks/round7b-check.ts':'scripts/drag-strips.ts'),original=readFileSync(file,'utf8')
 restore=()=>writeFileSync(file,original)
 let source=original.replace("import path from 'node:path'", "import path from 'node:path'\nimport {requireScreen} from '"+(mode==='tasks'?'../../perf/bench/':'../perf/bench/')+"screen-state.ts'\nimport {waitForWindowOnscreen,requireWindowOnscreen} from '"+(mode==='tasks'?'../../perf/bench/':'../perf/bench/')+"window-onscreen.ts'")
 if(mode==='tasks')source=source
  .replace("const shot=(file:string)=>{execFileSync('screencapture',['-x','-o','-l',windowId,file])}","const shot=async(file:string)=>{requireScreen();requireWindowOnscreen(fixture.pid);await app.screenshot({path:file})}")
  .replaceAll('shot(`${','await shot(`${')
  .replace("await app.getByTestId('app-ready').waitFor({timeoutMs:60000})", "await app.getByTestId('app-ready').waitFor({timeoutMs:60000});await waitForWindowOnscreen(fixture.pid)")
 else source=source
  .replace("await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })", "await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 });await waitForWindowOnscreen(fixture.pid);requireScreen()")
  .replaceAll('await app.screenshot(', 'await guardedCapture(app,') + '\nasync function guardedCapture(app:App,options:Parameters<App[\"screenshot\"]>[0]){requireScreen();requireWindowOnscreen(fixtures.get(app)!.pid);await app.screenshot(options)}\n'
 writeFileSync(file,source)
 if(mode==='tasks')await run(['native/ui-lease.ts','sidebar-fix-drags','bun','src/tasks/round7b-check.ts'])
 else {
  await run(['scripts/drag-seed.ts'])
  await run(['native/ui-lease.ts','sidebar-fix-dock','bun','scripts/drag-strips.ts','sidebar-fixed','dock-tabs'])
 }
}finally{child?.kill();restore();stopPid(state.daemonPid)}
