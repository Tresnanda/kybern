/** bun perf/bench/run.ts [scenario…] --runs 3 --label baseline-ef2251e2 */
import {assertScratchEnv} from '../../src/requests/harness.ts'
import {onExit} from './lifetime.ts'
import {mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs'
import {execFileSync} from 'node:child_process'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {actionFixture} from '../../src/pulls/verify.fixture.ts'
import {seed,DEFAULT_DATA} from './seed.ts'
import {SCENARIOS,table,emptyResult,type Scenario,type Result} from './model.ts'
import {scenario} from './scenarios.ts'
import {lease} from './lease.ts'
import {processInventory} from './process-gate.ts'
import {nativeBuildMarkers,quietMarkers,assertQuietTurn} from './build-overlap.ts'
const args=process.argv.slice(2),selected:Scenario[]=[]
let runs=3,label='local',seconds=15,warmup=10,keep=false,webkit=false,profile=false
for(let i=0;i<args.length;i++){
 const arg=args[i]!
 if(arg==='--runs')runs=Number(args[++i]);else if(arg==='--label')label=args[++i]!;else if(arg==='--seconds')seconds=Number(args[++i]);else if(arg==='--warmup')warmup=Number(args[++i]);else if(arg==='--keep-data')keep=true;else if(arg==='--webkit')webkit=true;else if(arg==='--profile')profile=true;else if(SCENARIOS.includes(arg as Scenario))selected.push(arg as Scenario);else throw Error(`Unknown argument ${arg}; scenarios: ${SCENARIOS.join(', ')}`)
}
if(runs*seconds+warmup*runs>220)throw Error('A scenario batch must fit within a four-minute measurement lease')
if(typeof label!=='string'||!Number.isFinite(seconds)||!Number.isFinite(warmup)||!/^[a-zA-Z0-9_.-]+$/.test(label)||!Number.isInteger(runs)||runs<1||runs>10||seconds<1||warmup<0)throw Error('Invalid benchmark arguments')
const app=path.resolve(import.meta.dir,'../..');process.chdir(app)
if(process.env.KYBERN_PACING_PARENT_LEASE===path.resolve(app,'../..')&&(selected.length!==1))throw Error('An external UI lease supports one scenario only; let run.ts lease a multi-scenario suite itself')
const addon=process.env.NAPI_RS_NATIVE_LIBRARY_PATH??path.join(app,'native/build/gpuix-native.darwin-arm64.node')
if(!webkit&&!existsSync(addon))throw Error('The patched baseline native addon is required; build native/update.sh or set NAPI_RS_NATIVE_LIBRARY_PATH to an approved addon')
const evidence=path.join(process.env.KYBERN_BENCH_EVIDENCE??'/Users/mymac/projects/ade/previews/gpuix/perf/bench',label)
mkdirSync(evidence,{recursive:true});mkdirSync(path.join(import.meta.dir,'results'),{recursive:true})
const started=performance.now(),results:Result[]=[]
let waitMs=0,aborted=true
const data=process.env.KYBERN_DATA_DIR??DEFAULT_DATA
assertScratchEnv({KYBERN_DATA_DIR:data,KYBERN_URL:'',KYBERN_CLIENT_CONFIG_DIR:path.join(data,'client')})
mkdirSync(data,{recursive:true})
const dataLock=path.join(data,'bench-run.lock');mkdirSync(dataLock)
const unlock=onExit(()=>rmSync(dataLock,{recursive:true,force:true}))
let fixture:Awaited<ReturnType<typeof seed>>
try{fixture=await seed(data,Number(process.env.KYBERN_BENCH_PORT??4322))}catch(e){rmSync(dataLock,{recursive:true,force:true});throw e}
const sha=webkit?'not-applicable':execFileSync('shasum',['-a','256',addon],{encoding:'utf8'}).split(' ')[0]
const sourceFiles=['src/nav/live.ts','src/nav/limits.ts','src/MatrixLoader.tsx','src/native/loop-visibility.ts','src/kit/Spin.tsx','src/kit/Skeleton.tsx','src/transcript/motion.tsx','src/shell/Connection.tsx','perf/bench/wheel.m']
const meta={sourceFiles:Object.fromEntries(sourceFiles.filter(file=>existsSync(path.join(app,file))).map(file=>[file,createHash('sha256').update(readFileSync(path.join(app,file))).digest('hex')])),schemaVersion:1,packetRateClock:'producer wall time',label,source:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),addonSha256:sha,daemonVersion:fixture.client.info?.version??null,daemonBinary:process.env.KYBERN_TEST_DAEMON??'/Applications/kybern.app/Contents/MacOS/kybernd',host:execFileSync('sw_vers',['-productVersion'],{encoding:'utf8'}).trim(),hardware:execFileSync('sysctl',['-n','machdep.cpu.brand_string'],{encoding:'utf8'}).trim(),bun:Bun.version,display:'60 Hz Retina LCD',fullRate:process.env.KYBERN_FULL_RATE??'1',warmupSeconds:warmup,resourceSeconds:seconds,runs,renderFlags:Object.fromEntries(['KYBERN_BENCH_DIRECT_VIEW','CADENCE_VISIBILITY_CONTROL','KYBERN_BENCH_NO_RUNNING','KYBERN_BENCH_INTEGER_WHEEL','KYBERN_REGION_PAINT','KYBERN_REGION_LAYERS','KYBERN_NATIVE_PAINT_ANIMATIONS','KYBERN_NATIVE_TEXT_PAINT','KYBERN_SCROLL_LAYOUT','KYBERN_SCROLL_ISLANDS','KYBERN_SCROLL_COALESCE','KYBERN_INPUT_FRAME_DRAW','KYBERN_STREAM_ISOLATE','KYBERN_STREAM_EVENT_FRAME','KYBERN_STREAM_DOCUMENT','KYBERN_BENCH_STREAM_HISTORY','KYBERN_BENCH_STREAM_SCROLL','KYBERN_BENCH_STREAM_CATCHUP'].map(key=>[key,process.env[key]??'app default'])),workload:{counts:fixture.manifest.counts,synthetic:fixture.manifest.synthetic},evidence,startedAt:new Date().toISOString()}
const save=()=>{const doc={...meta,elapsedSeconds:(performance.now()-started)/1000,leaseAndBuildWaitSeconds:waitMs/1000,executionSeconds:(performance.now()-started-waitMs)/1000,aborted,results};writeFileSync(path.join(import.meta.dir,`results/${label}.json`),JSON.stringify(doc,null,2));writeFileSync(path.join(import.meta.dir,`results/${label}.md`),table(results)+'\n')}
const unsave=onExit(()=>{aborted=true;save()})
let release:(()=>void)|undefined,leaseStarted=0,watchdog:ReturnType<typeof setTimeout>|undefined
try{
 const jobs=(selected.length?selected:[...SCENARIOS]).map(name=>({name,count:runs}))
 while(jobs.length){
  assertQuietTurn()
  const buildWaiting=performance.now();while(nativeBuildMarkers().length||processInventory().foreign.length)await Bun.sleep(1000);waitMs+=performance.now()-buildWaiting
  const {name,count}=jobs.shift()!,prior=results.length
  // A missing bundle or unimplemented reference needs no native UI lease.
  if(name==='startup-packaged'&&!existsSync(process.env.KYBERN_BENCH_PACKAGED_EXECUTABLE??path.join(app,'dist/Kybern GPUIX.app/Contents/MacOS/Kybern GPUIX'))&&!webkit){results.push(...await scenario(name,count,fixture,evidence,{seconds,warmup,profile}));save();continue}
  if(webkit&&!['startup-cold','startup-warm','open-long','thread-scroll','thread-fling','markdown-scroll','code-scroll','pr-summary','pr-changes','idle-home','idle-thread'].includes(name)){results.push(...Array.from({length:count},(_,i)=>({...emptyResult(name,i+1),host:'desktop frontend in WebKit',status:'skipped' as const,reason:'Reference scenario not implemented'})));save();continue}
  const waiting=performance.now();release=await lease();waitMs+=performance.now()-waiting;leaseStarted=performance.now()
  const markers=nativeBuildMarkers()
  if(markers.length){results.push(...Array.from({length:count},(_,i)=>({...emptyResult(name,i+1),status:'discarded' as const,reason:'build overlap: discarded',evidence:{buildMarkersBefore:markers,buildMarkersAfter:nativeBuildMarkers(),quietMarkersBefore:quietMarkers(),quietMarkersAfter:quietMarkers(),phase:'preflight; timing not started'}})));jobs.push({name,count});save();release();release=undefined;await Bun.sleep(1000);continue}
  watchdog=setTimeout(()=>{aborted=true;process.kill(process.pid,'SIGTERM')},250000)
  const attemptEvidence=path.join(evidence,`${name}-attempt-${results.filter(r=>r.scenario===name).length+1}`);mkdirSync(attemptEvidence,{recursive:true})
  if(webkit){
   const supported=['startup-cold','startup-warm','open-long','thread-scroll','thread-fling','markdown-scroll','code-scroll','pr-summary','pr-changes','idle-home','idle-thread']
   if(!supported.includes(name)){results.push(...Array.from({length:count},(_,i)=>({...emptyResult(name,i+1),host:'desktop frontend in WebKit',status:'skipped' as const,reason:'Reference scenario not implemented'})))}
   else {
    const proxy=name.startsWith('pr-')?actionFixture({long:true}):null
    const output=path.join(attemptEvidence,`webkit-${name}.json`)
    try{const child=Bun.spawn(['node',path.join(import.meta.dir,'webkit.mjs'),name,String(count),String(seconds),String(warmup),output],{env:{...process.env,...fixture.env,...proxy?.env,KYBERN_DATA_DIR:fixture.data,KYBERN_FULL_RATE:process.env.KYBERN_FULL_RATE??'1'},stdout:'inherit',stderr:'inherit'});const unchild=onExit(async()=>{child.kill();await Promise.race([child.exited,Bun.sleep(3000)])});const exit=await child.exited;unchild();if(exit)throw Error('WebKit reference failed');results.push(...JSON.parse(readFileSync(output,'utf8')))}finally{proxy?.close()}
   }
  }else results.push(...await scenario(name,count,fixture,attemptEvidence,{seconds,warmup,profile}));save()
  const discarded=results.slice(prior).filter(r=>r.status==='discarded').length
  if(discarded)jobs.push({name,count:discarded})
  clearTimeout(watchdog);watchdog=undefined;release();release=undefined
  console.log(`${name}: ${results.filter(r=>r.scenario===name).map(r=>r.status).join(', ')}`)
 }
 aborted=false
}finally{clearTimeout(watchdog);release?.();unsave();await fixture.close();rmSync(dataLock,{recursive:true,force:true});unlock();if(!keep)fixture.remove();save()}
console.log(table(results))
if(results.some(r=>r.status==='failed'))process.exitCode=1
