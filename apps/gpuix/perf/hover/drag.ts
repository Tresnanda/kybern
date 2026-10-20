/** Run the existing board/list/project drag regression in this lane's daemon. */
import {spawn} from 'node:child_process'
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs'
import path from 'node:path'
import {SCRATCH,DATA_DIR,startDaemon,readState,stopPid} from '../../visual/fixture.ts'
if(!SCRATCH.includes('/hr5-hover-drag'))throw Error('Use this lane drag scratch')
const out='/Users/mymac/projects/ade/previews/gpuix/handson-r5/hover/drag'
mkdirSync(out,{recursive:true})
const file=path.resolve('src/tasks/round7b-check.ts'),original=readFileSync(file,'utf8')
let child:ReturnType<typeof spawn>|undefined
const restore=()=>writeFileSync(file,original)
process.once('exit',restore)
for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>child?.kill(signal))
let state=await startDaemon(true)
try{
 writeFileSync(file,original.replace("import {mkdirSync,readFileSync,writeFileSync} from 'node:fs'","import {mkdirSync,readFileSync,writeFileSync} from 'node:fs'\nimport {requireScreen} from '../../perf/bench/screen-state.ts'\nimport {waitForWindowOnscreen,requireWindowOnscreen} from '../../perf/bench/window-onscreen.ts'")
  .replace("NAPI_RS_NATIVE_LIBRARY_PATH:path.resolve('native/build/gpuix-native.darwin-arm64.node')","NAPI_RS_NATIVE_LIBRARY_PATH:process.env.NAPI_RS_NATIVE_LIBRARY_PATH??path.resolve('native/build/gpuix-native.darwin-arm64.node')")
  .replace("const shot=(file:string)=>{execFileSync", "const shot=(file:string)=>{requireScreen();requireWindowOnscreen(fixture.pid);execFileSync")
  .replace("await app.getByTestId('app-ready').waitFor({timeoutMs:60000})", "await app.getByTestId('app-ready').waitFor({timeoutMs:60000});await waitForWindowOnscreen(fixture.pid)"))
 for(const [label,addon]of [['before',path.resolve('native/build/prior-hover.node')],['after',path.resolve('native/build/gpuix-native.darwin-arm64.node')]]){
  const env={...process.env,GPUIX_BACKGROUND:'1',KYBERN_URL:'',KYBERN_TOKEN:'',KYBERN_DATA_DIR:DATA_DIR,KYBERN_CLIENT_CONFIG_DIR:path.join(SCRATCH,'client'),R8_DATA:DATA_DIR,R8_OUT:out,R8_LANE:'hr5-hover-drag',R7_LABEL:label!,R7_SAMPLE:'0',R7_LOCK_HELD:'1',KYBERN_APPEARANCE:'dark',KYBERN_REDUCED_MOTION:'0',NAPI_RS_NATIVE_LIBRARY_PATH:addon!}
  child=spawn('bun',['native/ui-lease.ts','hr5-hover-drag','bun','perf/hover/drag-batch.ts'],{env,stdio:'inherit'})
  const code=await new Promise<number>((resolve,reject)=>{child!.once('error',reject);child!.once('exit',code=>resolve(code??1))});child=undefined
  if(code)throw Error(`Existing drag check failed: ${label}`)
 }
}finally{child?.kill();restore();process.off('exit',restore);state=readState()??state;stopPid(state.daemonPid);stopPid(state.proxyPid)}
