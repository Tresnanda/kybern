import {screenState} from '../bench/screen-state.ts'
/** One queued build-free window, released on every exit path. */
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { existsSync, openSync, closeSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
const directory=process.env.CADENCE_COORDINATION_DIR??'/tmp'
const lane = process.env.CADENCE_QUIET_LANE ?? 'perf-cadence', order = `${directory}/kybern-gpuix-quiet-order`, quiet = `${directory}/kybern-gpuix-quiet.${lane}`
const maximumMs=Math.min(24*60*1000,Number(process.env.CADENCE_MAX_SECONDS??1440)*1000)
if(!(maximumMs>0))throw Error('Invalid quiet deadline')
const names = (prefix: string) => readdirSync(directory).filter(name => name.startsWith(prefix))
function edit(action: string) {
  execFileSync('python3', ['-c', `import pathlib,sys,fcntl
p=pathlib.Path(sys.argv[1]);p.touch(exist_ok=True)
with p.open('r+') as f:
 fcntl.flock(f,fcntl.LOCK_EX)
 lines=[s for s in f.read().splitlines() if s];lane=sys.argv[2]
 if sys.argv[3]=='join' and lane not in lines: lines.append(lane)
 if sys.argv[3]=='leave': lines=[s for s in lines if s!=lane]
 f.seek(0);f.write(''.join(s+'\\n' for s in lines));f.truncate()
`, order, lane, action])
}
let nextScreenCheck=0,screenAvailable=false
function available(){if(process.env.CADENCE_COORDINATION_DIR)return true;if(Date.now()>=nextScreenCheck){screenAvailable=screenState().valid;nextScreenCheck=Date.now()+60000}return screenAvailable}
let owned = false, child: ChildProcess | undefined, stopped = false
let forced: ReturnType<typeof setTimeout> | undefined
const signalGroup=(signal:NodeJS.Signals)=>{if(child?.pid)try{process.kill(-child.pid,signal)}catch(e){if(!['ESRCH','EPERM'].includes((e as NodeJS.ErrnoException).code??''))throw e}}
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { stopped = true; signalGroup(signal); forced=setTimeout(()=>signalGroup('SIGKILL'),1000) })
const root=path.resolve(import.meta.dir,'../../../..')
// Recover only this checkout's abandoned run tokens before joining again.
for(const name of names('kybern-cadence-run.')){
 const file=`${directory}/${name}`
 try{
  const prior=JSON.parse(readFileSync(file,'utf8'))
  if(prior.root!==root||!prior.pid||!prior.lane)continue
  try{process.kill(prior.pid,0);continue}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw e}
  execFileSync('python3',[`${import.meta.dir}/quiet-watch.py`,file,String(prior.pid),prior.lane])
 }catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}
}
const state=`${directory}/kybern-cadence-run.${process.pid}.json`
const own={root,lane,pid:process.pid,quiet,order}
writeFileSync(state,JSON.stringify(own))
const guardian=spawnSync('python3',[`${import.meta.dir}/quiet-watch.py`,state,String(process.pid),lane,'--detach'],{stdio:'ignore'})
if(guardian.status!==0)throw Error('Quiet guardian failed to start')
edit('join')
try {
  while (!stopped && !owned) {
    const first = readFileSync(order, 'utf8').split('\n').filter(Boolean)[0]
    const reserved = names('kybern-gpuix-quiet-next.').filter(name => name !== `kybern-gpuix-quiet-next.${lane}`)
    if (first === lane && available() && !reserved.length && !names('kybern-gpuix-quiet.').length && !names('kybern-gpuix-native-build.').length && !names('kybern-gpuix-build-next.').length) {
      try {
        closeSync(openSync(quiet, 'wx')); owned = true
        writeFileSync(quiet, `${lane} pid=${process.pid} ${new Date().toISOString()} cadence paired metrics; expected end ${new Date(Date.now() + maximumMs).toISOString()}\n`)
        writeFileSync(state,JSON.stringify({...own,token:readFileSync(quiet,'utf8')}))
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    }
    if (!owned) await Bun.sleep(1000)
  }
  if (!stopped) {
    child = spawn(process.argv[2]!,process.argv.slice(3), { env: { ...process.env }, stdio: 'inherit', detached:true })
    writeFileSync(state,JSON.stringify({...own,group:child.pid,token:readFileSync(quiet,'utf8')}))
    const timeout = setTimeout(() => {signalGroup('SIGTERM');forced=setTimeout(()=>signalGroup('SIGKILL'),1000)}, maximumMs)
    process.exitCode = await new Promise<number>((resolve,reject)=>{child!.once('error',reject);child!.once('exit',code=>resolve(code??1))})
    clearTimeout(timeout)

  }
} finally {
  signalGroup('SIGKILL');if(forced)clearTimeout(forced)
  if (owned && existsSync(quiet)) unlinkSync(quiet)
  edit('leave')
  if(existsSync(state))unlinkSync(state)
}
